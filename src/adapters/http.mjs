// Test a live booking API over HTTP.
//
// This adapter makes no assumptions about whose API it is. Configure it with
// environment variables and point it at anything that allocates one resource
// from a pool:
//
//   BOOKING_URL      required. POST here to request one resource from the pool
//   BOOKING_AUTH     optional. Sent verbatim as the Authorization header
//   BOOKING_POOL     required. The pool identifier your API expects
//   BOOKING_BODY     optional. JSON template. {{pool}} {{from}} {{to}} {{caller}}
//                    are substituted. Default below suits a simple JSON API
//   BOOKING_VERIFY   required. GET here to list bookings for verification.
//                    Must return JSON: [{ resourceId, from, to }, ...]
//
// A 2xx is read as booked, a 409 as refused, anything else as an error.
//
// Verification reads back from your API and counts overlaps. If your API cannot
// list its own bookings, this adapter cannot verify it, and an unverifiable
// result is not a result.

const DEFAULT_BODY = '{"poolId":"{{pool}}","from":"{{from}}","to":"{{to}}","idempotencyKey":"{{caller}}"}';

function env(name, required = true) {
  const v = process.env[name];
  if (!v && required) throw new Error(`http adapter needs ${name}`);
  return v;
}

export default {
  name: "http",
  describe: "point at any live booking API over HTTP",

  async setup() {},

  async seed(_c, { poolId }) {
    // The pool must already exist in the target system. We do not create it,
    // because we have no idea how that system models resources.
    return [env("BOOKING_POOL")];
  },

  async attempt(_c, { slot, callerId }) {
    const body = (process.env.BOOKING_BODY ?? DEFAULT_BODY)
      .replaceAll("{{pool}}", env("BOOKING_POOL"))
      .replaceAll("{{from}}", slot.from)
      .replaceAll("{{to}}", slot.to)
      .replaceAll("{{caller}}", callerId);
    try {
      const res = await fetch(env("BOOKING_URL"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.BOOKING_AUTH ? { authorization: process.env.BOOKING_AUTH } : {}),
        },
        body,
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        return { outcome: "booked", resourceId: j.resourceId ?? j.resource_id ?? "unknown" };
      }
      if (res.status === 409) return { outcome: "refused", code: "409" };
      return { outcome: "error", code: String(res.status) };
    } catch (e) {
      return { outcome: "error", code: e.message.slice(0, 40) };
    }
  },

  async verify(_c, { slot }) {
    const res = await fetch(env("BOOKING_VERIFY"), {
      headers: process.env.BOOKING_AUTH ? { authorization: process.env.BOOKING_AUTH } : {},
    });
    if (!res.ok) throw new Error(`verify endpoint returned ${res.status}`);
    const rows = await res.json();
    let doubleAllocated = 0;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j];
        if (
          (a.resourceId ?? a.resource_id) === (b.resourceId ?? b.resource_id) &&
          new Date(a.from) < new Date(b.to) &&
          new Date(a.to) > new Date(b.from)
        ) doubleAllocated++;
      }
    }
    return { doubleAllocated };
  },
};
