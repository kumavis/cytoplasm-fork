// One benchmark case per process.
//
// Running every (implementation x suite) pair in its own process is the single
// most important property of this harness: when nine membrane implementations
// share a process, the proxy trap dispatch sites and the property access sites
// in the suite bodies go megamorphic, and every implementation measured after
// the first is penalised for the ones before it. Isolation also gives an honest
// place to measure startup, which is otherwise invisible.

import { measure } from './lib/measure.js'
import { findSuite } from './suites/index.js'
import { loadMembraneFactory, findMembrane } from './membranes/index.js'
import { installCounters } from './lib/instrument.js'
import { createGenerator } from './buildData.js'

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function emit (payload) {
  process.stdout.write(`__PERF__${JSON.stringify(payload)}\n`)
}

async function runStartup (membraneName) {
  // everything before this point is node boot; measure from here so the number
  // describes the library rather than the runtime
  const t0 = process.hrtime.bigint()
  const factory = await loadMembraneFactory(membraneName)
  const t1 = process.hrtime.bigint()
  const membrane = factory()
  const t2 = process.hrtime.bigint()
  const probe = { hello: 'world' }
  membrane.wrap(probe)
  const t3 = process.hrtime.bigint()
  // a second instance, to separate one-time module work from per-instance work
  const membrane2 = factory()
  const t4 = process.hrtime.bigint()
  membrane2.wrap({ hello: 'again' })
  const t5 = process.hrtime.bigint()

  const ms = (a, b) => Number(b - a) / 1e6
  emit({
    kind: 'startup',
    membrane: membraneName,
    importMs: ms(t0, t1),
    constructMs: ms(t1, t2),
    firstBridgeMs: ms(t2, t3),
    secondConstructMs: ms(t3, t4),
    secondBridgeMs: ms(t4, t5),
    readyMs: ms(t0, t3)
  })
}

async function runSuite (membraneName, suiteName, opts) {
  const suite = findSuite(suiteName)
  const entry = findMembrane(membraneName)
  const factory = await loadMembraneFactory(membraneName)
  const size = opts.size || suite.size

  const ctx = suite.prepare(factory, size)
  const makeState = suite.state ? () => suite.state(ctx) : () => ctx
  const stats = measure(suite.run, {
    makeState,
    freshState: Boolean(suite.freshState),
    opsPerRun: typeof suite.opsPerRun === 'function' ? suite.opsPerRun(size) : suite.opsPerRun,
    maxBatch: suite.maxBatch,
    warmupMs: opts.warmupMs,
    minSamples: opts.minSamples,
    minTimeMs: opts.minTimeMs,
    maxTimeMs: opts.maxTimeMs
  })

  emit({
    kind: 'suite',
    membrane: membraneName,
    group: entry.group,
    suite: suiteName,
    size,
    stats
  })
}

// Retained bytes per wrapped reference. Needs --expose-gc.
async function runMemory (membraneName, size) {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('perf worker: --memory needs node --expose-gc')
  }
  const factory = await loadMembraneFactory(membraneName)
  const membrane = factory()
  const data = createGenerator(12).createFlatData(size)
  // touch the wrap path once so its code is compiled and its lazy state built
  membrane.wrap({ warmup: true })

  globalThis.gc()
  globalThis.gc()
  const before = process.memoryUsage().heapUsed
  const wrapped = new Array(size)
  for (let i = 0; i < size; i++) {
    wrapped[i] = membrane.wrap(data[i])
  }
  globalThis.gc()
  globalThis.gc()
  const after = process.memoryUsage().heapUsed
  // keep everything reachable across the measurement
  if (wrapped.length !== size) throw new Error('unreachable')

  emit({
    kind: 'memory',
    membrane: membraneName,
    size,
    // subtract the holder array itself
    bytesPerWrap: (after - before - size * 8) / size
  })
}

// Exact operation counts on an already-warm proxy. These are integers, so any
// change to them is a real change, unlike the allocation-heavy timings.
async function runOps (membraneName) {
  const instrument = installCounters()
  const factory = await loadMembraneFactory(membraneName)
  const entry = findMembrane(membraneName)
  const membrane = factory()

  const gen = createGenerator(13)
  const target = membrane.wrap(gen.createMethodObj())
  const fresh = gen.createFlatData(64)

  const operations = {
    get: () => target.label,
    has: () => 'label' in target,
    'own-keys': () => Object.keys(target),
    'get-own-property-descriptor': () => Object.getOwnPropertyDescriptor(target, 'label')
  }
  if (entry.caps.writable) {
    operations.set = () => { target.id = 1 }
  }
  if (entry.caps.functions) {
    operations['method-call'] = () => target.combine('a', 'b')
  }

  const counts = {}
  for (const [name, run] of Object.entries(operations)) {
    // warm, so lazily-created caches are not attributed to the measured call
    run()
    instrument.reset()
    run()
    counts[name] = instrument.snapshot()
  }

  // cold wrap is measured separately: each one must see an unseen object
  instrument.reset()
  for (let i = 0; i < fresh.length; i++) membrane.wrap(fresh[i])
  const wrapSnapshot = instrument.snapshot()
  counts['wrap-cold'] = {}
  for (const [key, value] of Object.entries(wrapSnapshot)) {
    counts['wrap-cold'][key] = value / fresh.length
  }

  emit({ kind: 'ops', membrane: membraneName, counts })
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const membraneName = args.membrane
  if (!membraneName) throw new Error('perf worker: --membrane is required')

  if (args.startup) {
    await runStartup(membraneName)
    return
  }

  if (args.memory) {
    await runMemory(membraneName, args.size ? Number(args.size) : 2000)
    return
  }

  if (args.ops) {
    await runOps(membraneName)
    return
  }

  if (!args.suite) throw new Error('perf worker: --suite is required')
  await runSuite(membraneName, args.suite, {
    size: args.size ? Number(args.size) : undefined,
    warmupMs: args.warmupMs ? Number(args.warmupMs) : undefined,
    minSamples: args.minSamples ? Number(args.minSamples) : undefined,
    minTimeMs: args.minTimeMs ? Number(args.minTimeMs) : undefined,
    maxTimeMs: args.maxTimeMs ? Number(args.maxTimeMs) : undefined
  })
}

main().catch(err => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`)
  process.exit(1)
})
