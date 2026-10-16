// small statistics helpers for the perf harness
// all functions take an array of numbers and do not mutate it

export function sorted (values) {
  return values.slice().sort((a, b) => a - b)
}

export function quantile (sortedValues, q) {
  if (sortedValues.length === 0) return NaN
  if (sortedValues.length === 1) return sortedValues[0]
  const pos = (sortedValues.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const lower = sortedValues[base]
  const upper = sortedValues[base + 1]
  if (upper === undefined) return lower
  return lower + rest * (upper - lower)
}

export function mean (values) {
  if (values.length === 0) return NaN
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}

export function stddev (values) {
  if (values.length < 2) return 0
  const m = mean(values)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m
    sum += d * d
  }
  return Math.sqrt(sum / (values.length - 1))
}

// median absolute deviation - robust spread estimate
export function mad (values) {
  const s = sorted(values)
  const med = quantile(s, 0.5)
  const deviations = sorted(values.map(v => Math.abs(v - med)))
  return quantile(deviations, 0.5)
}

// relative margin of error (95% confidence) as a fraction of the mean
export function rme (values) {
  if (values.length < 2) return 0
  const m = mean(values)
  if (m === 0) return 0
  const sem = stddev(values) / Math.sqrt(values.length)
  return (1.96 * sem) / m
}

export function summarize (samples) {
  const s = sorted(samples)
  const median = quantile(s, 0.5)
  const madValue = mad(samples)
  return {
    samples: samples.length,
    min: s[0],
    p25: quantile(s, 0.25),
    median,
    p75: quantile(s, 0.75),
    max: s[s.length - 1],
    mean: mean(samples),
    stddev: stddev(samples),
    mad: madValue,
    // relative MAD - an outlier-resistant spread, which matters here because
    // GC pauses give these benchmarks a long right tail that wrecks stddev
    rmad: median === 0 ? 0 : madValue / median,
    rme: rme(samples)
  }
}

// median of a list of summaries' medians, used to combine repeated trials
export function combineTrials (trialStats) {
  const medians = trialStats.map(t => t.median)
  const s = sorted(medians)
  return {
    trials: trialStats.length,
    samples: trialStats.reduce((acc, t) => acc + t.samples, 0),
    median: quantile(s, 0.5),
    min: Math.min(...trialStats.map(t => t.min)),
    // how far apart the independent trials landed, relative to the median;
    // this is the number to distrust when it is large
    spread: medians.length > 1 ? (s[s.length - 1] - s[0]) / quantile(s, 0.5) : 0,
    rmad: Math.max(...trialStats.map(t => t.rmad)),
    rme: Math.max(...trialStats.map(t => t.rme))
  }
}
