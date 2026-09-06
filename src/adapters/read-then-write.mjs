// Read-then-write pooled allocation.
//
// The common shape: read who is free, choose one in application code, write.
// Nothing prevents two callers doing all three at once and choosing the same
// resource, because the read and the write are not in the same transaction and
// no constraint refuses the second write.
//
// This is not a strawman. It is transcribed from a widely deployed open-source
// scheduling product, read on 2026-09-05 at github.com/calcom/cal.com @ main.
// Four properties, each verifiable in that source:
//
//   1. availability is read with no transaction and no lock
//      packages/features/bookings/lib/handleNewBooking/ensureAvailableUsers.ts
//   2. the host is chosen by sorting on the last booking's createdAt and taking
//      the first. The selection function performs no database access at all;
//      users and their bookings arrive as parameters
//      packages/features/bookings/lib/getLuckyUser.ts  (leastRecentlyBookedUser)
//   3. the write runs in a transaction containing only the write
//      packages/features/bookings/lib/handleNewBooking/createBooking.ts
//   4. the Booking model has indexes on [startTime, endTime, status] and
//      [userId, status, startTime] and no unique constraint on time
//      packages/prisma/schema.prisma
//
// Verify it yourself before believing any of the above. The point of this
// harness is that you do not have to take anyone's word for it, including ours.

export default {
  name: "read-then-write",
  describe: "read availability, choose in app code, write. No lock, no constraint",

  async setup(c) {
    await c.query(`
      CREATE TABLE pools (id text PRIMARY KEY);
      CREATE TABLE resources (
        id      text PRIMARY KEY,
        pool_id text NOT NULL REFERENCES pools(id)
      );
      CREATE TABLE bookings (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        resource_id text NOT NULL REFERENCES resources(id),
        starts_at   timestamptz NOT NULL,
        ends_at     timestamptz NOT NULL,
        caller_id   text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      -- property 4: indexes, deliberately not unique
      CREATE INDEX bookings_time ON bookings (starts_at, ends_at);
      CREATE INDEX bookings_resource_time ON bookings (resource_id, starts_at);`);
  },

  async seed(c, { poolId, poolSize }) {
    await c.query(`INSERT INTO pools VALUES ($1)`, [poolId]);
    const ids = [];
    for (let i = 1; i <= poolSize; i++) {
      const id = `${poolId}-r${String(i).padStart(2, "0")}`;
      await c.query(`INSERT INTO resources VALUES ($1,$2)`, [id, poolId]);
      ids.push(id);
    }
    return ids;
  },

  async attempt(c, { poolId, slot, callerId }) {
    try {
      // 1. availability read. No transaction, no lock.
      const { rows: available } = await c.query(
        `SELECT r.id,
                (SELECT max(b.created_at) FROM bookings b WHERE b.resource_id = r.id)
                  AS last_booked_at
           FROM resources r
          WHERE r.pool_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM bookings b
               WHERE b.resource_id = r.id
                 AND b.starts_at < $3 AND b.ends_at > $2)`,
        [poolId, slot.from, slot.to]
      );
      if (available.length === 0) {
        return { outcome: "refused", code: "no_available_resource" };
      }

      // 2. choose in application code: least recently booked, ties by id.
      available.sort((a, b) => {
        const at = a.last_booked_at ? +new Date(a.last_booked_at) : 0;
        const bt = b.last_booked_at ? +new Date(b.last_booked_at) : 0;
        return at - bt || a.id.localeCompare(b.id);
      });
      const chosen = available[0];

      // 3. write, in a transaction that contains only the write.
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO bookings (resource_id, starts_at, ends_at, caller_id)
         VALUES ($1,$2,$3,$4)`,
        [chosen.id, slot.from, slot.to, callerId]
      );
      await c.query("COMMIT");
      return { outcome: "booked", resourceId: chosen.id };
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      return { outcome: "error", code: e.code ?? e.message.slice(0, 40) };
    }
  },

  async verify(c) {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n
         FROM bookings a JOIN bookings b
           ON a.resource_id = b.resource_id
          AND a.id < b.id
          AND a.starts_at < b.ends_at AND a.ends_at > b.starts_at`
    );
    return { doubleAllocated: rows[0].n };
  },
};
