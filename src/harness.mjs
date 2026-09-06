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
  const started = Date.now();

  for (let round = 0; round < ROUNDS; round++) {
    const admin = new pg.Client(CONN);
    await admin.connect();
    await admin.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await adapter.setup(admin);

    const poolId = `p${round}`;
    const slot = { from: "2026-10-01T10:00:00Z", to: "2026-10-01T11:00:00Z" };
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
        return adapter.attempt(c, { poolId, resourceIds, slot, callerId: `c${i}` });
      })
    );
    await Promise.all(clients.map(c => c.end().catch(() => {})));

    for (const r of results) {
      totals[r.outcome] = (totals[r.outcome] ?? 0) + 1;
      if (r.outcome === "error") errorCodes[r.code] = (errorCodes[r.code] ?? 0) + 1;
    }
    doubleAllocated += (await adapter.verify(admin, { slot })).doubleAllocated;
    await admin.end();
  }

  const attempts = CALLERS * ROUNDS;
  const ms = Date.now() - started;
  console.log(`
adapter          ${adapter.name}
                 ${adapter.describe}
shape            ${CALLERS} callers, pool of ${POOL}, ${ROUNDS} rounds, ${attempts} attempts, ${ms}ms

  booked         ${totals.booked}
  refused        ${totals.refused}
  error          ${totals.error}${Object.keys(errorCodes).length ? "   " + JSON.stringify(errorCodes) : ""}

  DOUBLE ALLOCATED   ${doubleAllocated}${doubleAllocated === 0 ? "   pass" : "   FAIL"}
`);

  if (args.assert && doubleAllocated !== 0) failed = true;
  if (args["expect-failure"] && doubleAllocated === 0) {
    console.log("expected this adapter to double-allocate and it did not");
    failed = true;
  }
} finally {
  await pgs.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
