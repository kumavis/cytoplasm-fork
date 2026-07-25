# perf

A measurement harness for cytoplasm, built to be trustworthy enough to make
optimization decisions from.

```sh
yarn performance                        # full comparison, ~5 min
yarn performance:quick                  # cytoplasm rows only, ~1 min
node perf/run.js --suites get,deep-get --trials 5
node perf/run.js --label my-change --notes "what changed" --save
node perf/report.js                     # timeseries across every saved run
```

## Why it is shaped this way

**One process per case.** Every (implementation x suite) pair runs in its own
`node` process. When nine membrane implementations share a process, the proxy
trap dispatch sites and the property access sites inside the suite bodies go
megamorphic, and every implementation measured after the first pays for the
ones before it. Process isolation also gives an honest place to measure
startup, which is invisible from inside a warmed-up process.

**Setup is never timed.** Suites split into `prepare` (once) and, for the
first-contact suites, `state` (before each timed iteration). The previous
harness built and wrapped its fixtures *inside* the timed function, so the
`get` numbers were substantially a measurement of object allocation, and the
`set` numbers measured nothing at all - the benchmark body replaced every
wrapped object with a plain `{}` on the first iteration.

**Work is batched.** The timed region is calibrated to about 2 ms, so
`hrtime` overhead and clock granularity do not show up in the result.

**Robust statistics.** Membranes allocate heavily, so the sample distribution
has a long GC tail; a mean is a measurement of when the collector happened to
run. Results are reported as the median, with the median absolute deviation
(`mad%`) as the spread and the spread across independent trials (`trial%`) as
the reproducibility check. Distrust any row where those are large.

**Normalised units.** The headline number is nanoseconds per elementary
operation (`ns/op`), not operations per second of a 100-element loop, so
suites of different sizes are directly comparable.

**Deterministic fixtures.** `buildData.js` is seeded, so two runs on two
commits see byte-identical inputs.

## Layout

| path | role |
|---|---|
| `run.js` | orchestrator: spawns workers, aggregates trials, prints tables, saves results |
| `worker.js` | runs exactly one case in a fresh process |
| `lib/measure.js` | the timing loop |
| `lib/stats.js` | median / MAD / quantiles |
| `suites/index.js` | benchmark definitions |
| `membranes/index.js` | registry of implementations plus their capabilities |
| `results/` | one JSON file per recorded run, the input to `report.js` |

## Capabilities

Implementations declare what they can actually do, and suites declare what
they need, so unsupported combinations are skipped rather than silently
measuring something else. This matters: `fast-membrane` and
`observable-membrane` hand functions and classes back **unwrapped**, so
benchmarking `call` or `construct` against them would be benchmarking a bare
function call.
