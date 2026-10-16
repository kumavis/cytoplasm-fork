// A measurement loop built for this project's needs:
//
//  - per-iteration setup is excluded from the timed region, so "cold wrap"
//    benchmarks measure wrapping instead of measuring object construction
//  - work is batched so that a single timed region is comfortably larger than
//    clock resolution, which removes hrtime overhead from the numbers
//  - many samples are collected and reported with robust statistics (median,
//    MAD, quantiles) instead of a single mean, because membranes are very
//    GC-sensitive and the mean is dominated by collection pauses
//  - results are reported as nanoseconds per elementary operation, so that
//    suites of different sizes stay comparable

import { summarize } from './stats.js'

const now = process.hrtime.bigint

// keeps the optimizer from eliminating benchmark bodies whose results are unused
export const sink = { value: undefined }

const DEFAULTS = {
  warmupMs: 250,
  minSamples: 25,
  minTimeMs: 700,
  maxTimeMs: 3500,
  targetSampleNs: 2e6,
  maxBatch: 1e5
}

function nowNs () {
  return Number(now())
}

// find a batch size whose timed region is ~targetSampleNs long
function calibrate (fn, makeState, opts) {
  let best = Infinity
  for (let i = 0; i < 5; i++) {
    const state = makeState()
    const t0 = nowNs()
    sink.value = fn(state)
    const dur = nowNs() - t0
    if (dur < best) best = dur
  }
  if (!(best > 0)) best = 1
  const batch = Math.round(opts.targetSampleNs / best)
  return Math.max(1, Math.min(opts.maxBatch, batch))
}

function runBatch (fn, states) {
  const t0 = nowNs()
  for (let i = 0; i < states.length; i++) {
    sink.value = fn(states[i])
  }
  return nowNs() - t0
}

/**
 * @param {(state: any) => any} fn the timed body
 * @param {object} options
 * @param {() => any} options.makeState produces the argument for `fn`
 * @param {boolean} options.freshState when true `makeState` runs before every
 *   timed iteration (untimed); when false it runs once and the state is shared
 * @param {number} options.opsPerRun elementary operations performed by one `fn` call
 */
export function measure (fn, options) {
  const opts = { ...DEFAULTS }
  // an explicitly-passed `undefined` must not clobber a default
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) opts[key] = value
  }
  const { makeState, freshState = false, opsPerRun = 1 } = opts

  const shared = freshState ? null : makeState()
  const makeOne = freshState ? makeState : () => shared

  const batch = calibrate(fn, makeOne, opts)
  const states = new Array(batch)
  const fill = () => {
    for (let i = 0; i < batch; i++) states[i] = makeOne()
  }

  // warmup: let V8 tier up and settle the inline caches
  const warmupEnd = nowNs() + opts.warmupMs * 1e6
  while (nowNs() < warmupEnd) {
    fill()
    runBatch(fn, states)
  }

  const samples = []
  const start = nowNs()
  const minEnd = start + opts.minTimeMs * 1e6
  const maxEnd = start + opts.maxTimeMs * 1e6
  while (true) {
    fill()
    const dur = runBatch(fn, states)
    samples.push(dur / batch)
    const t = nowNs()
    if (t >= maxEnd) break
    if (samples.length >= opts.minSamples && t >= minEnd) break
  }

  const stats = summarize(samples)
  return {
    ...stats,
    batch,
    opsPerRun,
    // headline metric: nanoseconds per elementary operation
    nsPerOp: stats.median / opsPerRun,
    hz: 1e9 / stats.median
  }
}
