# Pooled allocation conformance

Does your booking API hand the same resource to two callers at once?

N callers ask one pool of M interchangeable resources for the same window, at the
same instant. Every caller is a separate connection held at a barrier, so they are
genuinely simultaneous. Afterwards one query reads the table back and counts
overlapping bookings on the same resource.

That count must be zero. It is read from the data, never from a counter the write
path maintained, because a counter fed by the writer can only report that the
writer thinks it succeeded.

## Run it

```
npm install
node src/harness.mjs --adapter read-then-write
```

Postgres is embedded and temporary. Nothing is installed and nothing persists.

```
--adapter <name>   implementation to test
--callers <n>      simultaneous callers        (default 16)
--pool <n>         interchangeable resources   (default 8)
--rounds <n>       repetitions                 (default 20)
--assert           exit 1 unless double allocated is 0
--list             show adapters
```

## What ships

| Adapter | What it does under contention |
|---|---|
| `read-then-write` | reads availability, chooses in application code, writes. No lock, no constraint |
| `http` | points at any live booking API. Configure with environment variables |

**There is no "correct" adapter in this repo, on purpose.** Shipping one would
just be an argument. Point the `http` adapter at a service that claims to get this
right and let it answer for itself.

`read-then-write` is not a strawman. Its four properties are transcribed from a
widely deployed open-source scheduling product, with file paths in the adapter's
comments so you can check every one. **We publish the method, not a scoreboard.**
No vendor is named in output, no vendor's servers are contacted, and no result
about any vendor is published here. Point it at whatever you want and draw your
own conclusions.

## Add your own

An adapter is five functions: `setup`, `seed`, `attempt`, `verify`, plus a name and
a one-line description. The contract is documented in `src/adapters/index.mjs`.
Adapters that speak HTTP rather than SQL are welcome and the interface allows them.

## Reading the output

`booked + refused + error` should equal the attempt count. A `refused` is a good
answer: the pool had nothing, the caller was told so, nobody was double-booked.
An `error` means the caller could not tell what happened, which is worse than a
refusal.

Latency is reported but is not the test. An implementation that is fast and wrong
has not passed anything.

One finding worth having before you benchmark anyone, including yourself. If the
implementation under test uses a Postgres constraint to refuse overlaps, its
latency under contention is set by `deadlock_timeout`, not by the constraint.
Postgres waits a full second by default before checking for a deadlock cycle.
Measured here on identical work with identical results: **32,753ms at the 1s
default, 1,292ms at 50ms.** Most of what looks like the cost of correctness is
that one setting. Use `--deadlock-timeout` and say which value you used.

MIT.
