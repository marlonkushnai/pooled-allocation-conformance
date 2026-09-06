#!/usr/bin/env node
// Pooled allocation conformance harness.
//
//   node src/harness.mjs --adapter <name> [--callers 16] [--pool 8] [--rounds 20]
//
// N callers ask one pool of M interchangeable resources for the same window, at
// the same moment. Every caller is a distinct connection released by a barrier,
// so they are genuinely simultaneous rather than merely concurrent-looking.
//
// The only number that matters is `double allocated`. It must be 0. It is read
// back from the table by a query, never from a counter the write path kept.

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getAdapter, adapters } from "./adapters/index.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) =>
    a.startsWith("--") ? [[a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : []
  )
);

if (args.help || (!args.adapter && !args["adapter-file"] && !args.list)) {
  console.log(`pooled allocation conformance

  --adapter <name>       built-in implementation to test
  --adapter-file <path>  load an adapter from anywhere on disk. Use this for
                         implementations you do not want in this repo
  --callers <n>      simultaneous callers        (default 16)
  --pool <n>         interchangeable resources   (default 8)
  --rounds <n>       repetitions                 (default 20)
  --slot <YYYY-MM-DD>  race a specific date, to avoid a dirty window
  --assert           exit 1 unless double allocated is 0
  --expect-failure   exit 1 unless double allocated is > 0
  --deadlock-timeout <ms>  override Postgres deadlock_timeout for callers
  --list             show adapters

adapters:
${Object.values(adapters).map(a => `  ${a.name.padEnd(22)}${a.describe}`).join("\n")}`);
  process.exit(0);
}
if (args.list) {
  for (const a of Object.values(adapters)) console.log(`${a.name.padEnd(22)}${a.describe}`);
  process.exit(0);
}

const CALLERS = Number(args.callers ?? 16);
const POOL    = Number(args.pool ?? 8);
const ROUNDS  = Number(args.rounds ?? 20);
// A run id, so idempotency keys are unique per invocation. Without it a second
// run reuses the first run's keys with a different body, which any correct API
// answers with 422 -- as it should.
export const RUN_ID = Math.random().toString(36).slice(2, 10);

const adapter = args["adapter-file"]
  ? (await import(pathToFileURL(resolve(String(args["adapter-file"]))).href)).default
  : getAdapter(String(args.adapter));

const dir = mkdtempSync(join(tmpdir(), "conformance-"));
const PORT = 55000 + Math.floor(Math.random() * 9000);
const CONN = { host: "localhost", port: PORT, user: "harness", password: "harness", database: "postgres" };

function barrier(n) {
  let arrived = 0, release;
  const gate = new Promise(r => (release = r));
  return async () => { if (++arrived === n) release(); await gate; };
}

const pgs = new EmbeddedPostgres({
  databaseDir: dir, user: "harness", password: "harness", port: PORT, persistent: false,
});

let failed = false;
try {
  await pgs.initialise();
  await pgs.start();

  const totals = { booked: 0, refused: 0, error: 0 };
  const errorCodes = {};
  let doubleAllocated = 0;
  let unverifiable = null;   // set when verify could not read what it was given
  const started = Date.now();

  for (let round = 0; round < ROUNDS; round++) {
    const admin = new pg.Client(CONN);
    await admin.connect();
    await admin.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await adapter.setup(admin);

    const poolId = `p${round}`;
    const slot = args.slot
      ? { from: `${args.slot}T10:00:00Z`, to: `${args.slot}T11:00:00Z` }
      : { from: "2026-10-01T10:00:00Z", to: "2026-10-01T11:00:00Z" };
    const resourceIds = await adapter.seed(admin, { poolId, poolSize: POOL, slot });

    const clients = Array.from({ length: CALLERS }, () => new pg.Client(CONN));
    await Promise.all(clients.map(c => c.connect()));
    const gate = barrier(CALLERS);

    const results = await Promise.all(
      clients.map(async (c, i) => {
        if (args["deadlock-timeout"]) {
          await c.query(`SELECT set_config('deadlock_timeout', $1, false)`,
            [String(args["deadlock-timeout"])]);
        }
        await gate();
        return adapter.attempt(c, { poolId, resourceIds, slot, callerId: `${RUN_ID}-c${i}` });
      })
    );
    await Promise.all(clients.map(c => c.end().catch(() => {})));

    for (const r of results) {
      totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;
      if (r.outcome === "error") errorCodes[r.code] = (errorCodes[r.code] ?? 0) + 1;
    }
    // A verify that cannot read its input has not measured anything. Let it say
    // so rather than letting an exception look like a crash or a zero look like
    // a pass.
    try {
      doubleAllocated += (await adapter.verify(admin, { slot })).doubleAllocated;
    } catch (e) {
      unverifiable = e.message;
    }
    await admin.end();
    if (unverifiable) break;
  }

  const attempts = CALLERS * ROUNDS;
  const verdict = unverifiable || totals.booked === 0
    ? "INCONCLUSIVE"
    : doubleAllocated === 0 ? "pass" : "FAIL";
  const ms = Date.now() - started;
  console.log(`
adapter          ${adapter.name}
                 ${adapter.describe}
shape            ${CALLERS} callers, pool of ${POOL}, ${ROUNDS} rounds, ${attempts} attempts, ${ms}ms

  booked         ${totals.booked}
  refused        ${totals.refused}
  error          ${totals.error}${Object.keys(errorCodes).length ? "   " + JSON.stringify(errorCodes) : ""}

  DOUBLE ALLOCATED   ${unverifiable ? "?" : doubleAllocated}   ${verdict}
`);

  if (unverifiable) {
    console.log(`INCONCLUSIVE: the verify step could not read the data it was given, so no
count was produced. This is not a pass.

  ${unverifiable}\n`);
    if (args.assert || args["expect-failure"]) failed = true;
  }

  // A run in which nothing was booked cannot prove anything. Zero double
  // allocations out of zero successful bookings is not a pass, it is a test that
  // did not run. Saying otherwise is the worst thing a conformance tool can do.
  if (!unverifiable && totals.booked === 0) {
    console.log(`INCONCLUSIVE: nothing was booked, so nothing could be double allocated.
Check the adapter configuration and the error codes above before reading anything
into the result.\n`);
    if (args.assert || args["expect-failure"]) failed = true;
  }

  if (args.assert && !unverifiable && doubleAllocated !== 0) failed = true;
  if (args["expect-failure"] && !unverifiable && doubleAllocated === 0) {
    console.log("expected this adapter to double-allocate and it did not");
    failed = true;
  }
} finally {
  await pgs.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
