// Adapter contract.
//
// An adapter teaches the harness how one implementation allocates from a pool.
// Implement these five and the harness can race yours against any other.
//
//   name        string, shown in output
//   describe    one line: what this implementation does under contention
//   setup(c)    create whatever schema this implementation needs, if any
//   seed(c, {poolId, poolSize, slot})   create the pool; return the resource ids
//   attempt(c, ctx)                     ONE caller's attempt to take one resource
//   verify(c, {slot})                   count double allocations. Zero, or it failed
//
// `attempt` returns { outcome, resourceId?, code? } where outcome is one of:
//   'booked'    this caller got a resource
//   'refused'   the pool had nothing for this caller. A correct, useful answer
//   'error'     anything else. The caller cannot tell what happened
//
// ctx = { poolId, resourceIds, slot, callerId }
//
// The harness never inspects your tables. `verify` is the only claim it trusts,
// and it must read the data back, not report a counter your write path kept.
// A counter fed by the writer can only tell you the writer thinks it succeeded.

import readThenWrite from "./read-then-write.mjs";
import http from "./http.mjs";

export const adapters = {
  [readThenWrite.name]: readThenWrite,
  [http.name]: http,
};

export function getAdapter(name) {
  const a = adapters[name];
  if (!a) {
    throw new Error(
      `Unknown adapter "${name}". Available: ${Object.keys(adapters).join(", ")}`
    );
  }
  return a;
}
