// Test a live booking API over HTTP.
//
// This adapter makes no assumptions about whose API it is. Configure it with
// environment variables and point it at anything that allocates one resource
// from a pool:
//
//   BOOKING_URL      required. POST here to request one resource from the pool
//   BOOKING_AUTH     optional. Sent verbatim as the Authorization header
//   BOOKING_HEADERS  optional. JSON object of extra headers. {{caller}} is
//                    substituted, so an idempotency header can be per-caller:
//                    {"Idempotency-Key":"{{caller}}"}
//                    {{caller}} is unique per run, so keys never collide across
//                    invocations. A correct API answers a reused key carrying a
//                    different body with 422, which would otherwise look like a
//                    harness failure.
//   BOOKING_POOL     required. The pool identifier your API expects
//   BOOKING_BODY     optional. JSON template. {{pool}} {{from}} {{to}} {{caller}}
//                    are substituted. Default below suits a simple JSON API
//   BOOKING_VERIFY   required. GET here to list bookings for verification.
//                    Must return JSON: [{ resourceId, from, to }, ...] where from
//                    and to parse as timestamps. If they do not, this adapter
//                    refuses to answer rather than answering zero.
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
          ...JSON.parse(
            (process.env.BOOKING_HEADERS ?? "{}").replaceAll("{{caller}}", callerId)
          ),
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

  // Every comparison here must be between two numbers we understand.
  //
  // new Date(null) is the epoch, not an error. new Date(undefined) and
  // new Date("not a date") are Invalid Date, and every < or > against Invalid
  // Date is false. So the obvious implementation reports ZERO overlaps for a
  // target that returned nothing readable, and zero prints as "pass". That is
  // the one direction a conformance tool must never be wrong in: it hands a
  // clean bill of health to an API that is double-booking freely. Parse
  // strictly and refuse to answer instead.
  async verify(_c, { slot }) {
    const res = await fetch(env("BOOKING_VERIFY"), {
      headers: process.env.BOOKING_AUTH ? { authorization: process.env.BOOKING_AUTH } : {},
    });
    if (!res.ok) throw new Error(`verify endpoint returned ${res.status}`);

    const rows = await res.json();
    if (!Array.isArray(rows))
      throw new Error(`verify endpoint returned ${typeof rows}, expected a JSON array of bookings`);

    const at = (row, field, index) => {
      const v = row[field];
      const t = Date.parse(v);
      if (v == null || Number.isNaN(t))
        throw new Error(
          `row ${index} has ${field}=${JSON.stringify(v)}, which is not a timestamp this ` +
          `adapter can compare. Overlap cannot be computed, so no result is reported. ` +
          `Make the verify endpoint return ISO 8601 bounds, or write an adapter that ` +
          `understands the format yours uses.`
        );
      return t;
    };

    const parsed = rows.map((r, i) => {
      const id = r.resourceId ?? r.resource_id;
      if (id == null)
        throw new Error(`row ${i} has neither resourceId nor resource_id, so overlaps ` +
                        `cannot be attributed to a resource`);
      return { id, from: at(r, "from", i), to: at(r, "to", i) };
    });

    let doubleAllocated = 0;
    for (let i = 0; i < parsed.length; i++) {
      for (let j = i + 1; j < parsed.length; j++) {
        const a = parsed[i], b = parsed[j];
        if (a.id === b.id && a.from < b.to && a.to > b.from) doubleAllocated++;
      }
    }
    return { doubleAllocated };
  },
};
