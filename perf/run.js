// Benchmark orchestrator.
//
//   node perf/run.js                                  # the default comparison
//   node perf/run.js --only cytoplasm                 # just the cytoplasm rows
//   node perf/run.js --suites get,deep-get --trials 5
//   node perf/run.js --label my-change --save         # record a data point
//
// Cases run strictly one at a time, each in its own process, because anything
// else makes the numbers a measurement of scheduler luck.

import { spawn, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, writeFileSync, readdirSync } from 'fs'
import os from 'os'

import { membranes, findMembrane } from './membranes/index.js'
import { suites, supports } from './suites/index.js'
import { combineTrials } from './lib/stats.js'

const here = dirname(fileURLToPath(import.meta.url))
const workerPath = join(here, 'worker.js')
const resultsDir = join(here, 'results')

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

function runWorker (workerArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, ...workerArgs], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('close', (code) => {
      const line = out.split('\n').find(l => l.startsWith('__PERF__'))
      if (code !== 0 || !line) {
        resolve({ error: err.trim() || `worker exited with code ${code}` })
        return
      }
      resolve({ payload: JSON.parse(line.slice('__PERF__'.length)) })
    })
  })
}

function gitInfo () {
  const git = (args, fallback) => {
    try {
      return execFileSync('git', args, { cwd: here, encoding: 'utf8' }).trim()
    } catch (err) {
      return fallback
    }
  }
  return {
    sha: git(['rev-parse', 'HEAD'], 'unknown'),
    shortSha: git(['rev-parse', '--short', 'HEAD'], 'unknown'),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown'),
    subject: git(['log', '-1', '--pretty=%s'], 'unknown'),
    dirty: git(['status', '--porcelain'], '') !== ''
  }
}

function envInfo () {
  const cpus = os.cpus()
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: `${os.platform()}-${os.arch()}`,
    cpu: cpus.length ? cpus[0].model : 'unknown',
    cores: cpus.length,
    totalMemGb: Math.round(os.totalmem() / 1e9)
  }
}

function selectMembranes (args) {
  let selected = membranes
  if (args.only) {
    const groups = String(args.only).split(',')
    selected = selected.filter(m => groups.includes(m.group))
  }
  if (args.membranes) {
    const names = String(args.membranes).split(',')
    selected = names.map(findMembrane)
  }
  return selected
}

function selectSuites (args) {
  let selected = suites
  if (args.suites) {
    const names = String(args.suites).split(',')
    selected = names.map(name => {
      const suite = suites.find(s => s.name === name)
      if (!suite) throw new Error(`perf: unknown suite "${name}"`)
      return suite
    })
  }
  return selected
}

function fmt (value, digits = 1) {
  if (value === undefined || value === null || Number.isNaN(value)) return '-'
  return value.toFixed(digits)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const quick = Boolean(args.quick)
  const trials = args.trials ? Number(args.trials) : (quick ? 1 : 3)
  const startupTrials = args.startupTrials ? Number(args.startupTrials) : (quick ? 3 : 11)
  const size = args.size ? Number(args.size) : undefined

  const timing = quick
    ? ['--warmupMs', '100', '--minSamples', '10', '--minTimeMs', '250', '--maxTimeMs', '900']
    : []

  const selectedMembranes = selectMembranes(args)
  const selectedSuites = selectSuites(args)

  const env = envInfo()
  const git = gitInfo()

  console.log('cytoplasm performance harness')
  console.log(`  node ${env.node} (v8 ${env.v8}) on ${env.platform}, ${env.cores} cores`)
  console.log(`  commit ${git.shortSha}${git.dirty ? '+dirty' : ''} on ${git.branch}`)
  console.log(`  ${selectedMembranes.length} implementations x ${selectedSuites.length} suites x ${trials} trials, isolated processes`)

  const cases = []
  const unavailable = new Set()

  const total = selectedMembranes.length * selectedSuites.length
  let done = 0

  for (const suite of selectedSuites) {
    for (const entry of selectedMembranes) {
      done++
      if (!supports(entry, suite)) {
        process.stderr.write(`  [${done}/${total}] skip  ${suite.name} / ${entry.name} (unsupported)\n`)
        continue
      }
      if (unavailable.has(entry.name)) {
        process.stderr.write(`  [${done}/${total}] skip  ${suite.name} / ${entry.name} (unavailable)\n`)
        continue
      }
      const trialStats = []
      let failure = null
      for (let trial = 0; trial < trials; trial++) {
        const workerArgs = ['--membrane', entry.name, '--suite', suite.name, ...timing]
        if (size) workerArgs.push('--size', String(size))
        const { payload, error } = await runWorker(workerArgs)
        if (error) {
          failure = error
          break
        }
        trialStats.push(payload.stats)
      }
      if (failure) {
        if (entry.optional) unavailable.add(entry.name)
        process.stderr.write(`  [${done}/${total}] FAIL  ${suite.name} / ${entry.name}: ${failure.split('\n')[0]}\n`)
        continue
      }
      const combined = combineTrials(trialStats)
      const opsPerRun = trialStats[0].opsPerRun
      const record = {
        suite: suite.name,
        membrane: entry.name,
        group: entry.group,
        opsPerRun,
        nsPerOp: combined.median / opsPerRun,
        runNs: combined.median,
        hz: 1e9 / combined.median,
        rmad: combined.rmad,
        rme: combined.rme,
        trialSpread: combined.spread,
        trials: trialStats.map(t => t.median / opsPerRun)
      }
      cases.push(record)
      process.stderr.write(`  [${done}/${total}] ok    ${suite.name} / ${entry.name}: ${fmt(record.nsPerOp, 1)} ns/op (mad ${fmt(combined.rmad * 100, 1)}%, trials ${fmt(combined.spread * 100, 1)}%)\n`)
    }
  }

  // startup is measured separately: one fresh process per sample
  const startup = {}
  if (!args.noStartup) {
    for (const entry of selectedMembranes) {
      if (unavailable.has(entry.name)) continue
      const samples = []
      for (let i = 0; i < startupTrials; i++) {
        const { payload } = await runWorker(['--membrane', entry.name, '--startup'])
        if (payload) samples.push(payload)
      }
      if (!samples.length) continue
      const median = (key) => {
        const values = samples.map(s => s[key]).sort((a, b) => a - b)
        return values[Math.floor(values.length / 2)]
      }
      startup[entry.name] = {
        importMs: median('importMs'),
        constructMs: median('constructMs'),
        firstBridgeMs: median('firstBridgeMs'),
        secondConstructMs: median('secondConstructMs'),
        readyMs: median('readyMs'),
        samples: samples.length
      }
    }
  }

  report({ cases, startup, selectedSuites, selectedMembranes })

  const result = {
    label: args.label ? String(args.label) : `${git.shortSha}${git.dirty ? '-dirty' : ''}`,
    notes: args.notes ? String(args.notes) : '',
    timestamp: new Date().toISOString(),
    git,
    env,
    config: { trials, startupTrials, quick, size: size || null },
    cases,
    startup
  }

  if (args.save) {
    mkdirSync(resultsDir, { recursive: true })
    const existing = readdirSync(resultsDir).filter(f => f.endsWith('.json'))
    const seq = String(existing.length + 1).padStart(3, '0')
    const slug = result.label.replace(/[^a-zA-Z0-9._-]+/g, '-')
    const file = join(resultsDir, `${seq}-${slug}.json`)
    writeFileSync(file, JSON.stringify(result, null, 2) + '\n')
    console.log(`\nsaved ${file}`)
  }
}

function report ({ cases, startup, selectedSuites, selectedMembranes }) {
  const byMembrane = {}
  for (const record of cases) {
    byMembrane[record.membrane] = byMembrane[record.membrane] || {}
    byMembrane[record.membrane][record.suite] = record
  }

  for (const suite of selectedSuites) {
    const rows = cases.filter(c => c.suite === suite.name)
    if (!rows.length) continue
    const baseline = rows.find(r => r.membrane === 'non-membrane:bare')
    console.log(`\n== ${suite.name} ==  ${suite.description}`)
    const table = {}
    for (const row of rows) {
      table[row.membrane] = {
        'ns/op': Number(row.nsPerOp.toFixed(1)),
        'ops/sec': Math.round(row.hz),
        'vs bare': baseline ? `${(row.nsPerOp / baseline.nsPerOp).toFixed(1)}x` : '-',
        'mad%': Number((row.rmad * 100).toFixed(1)),
        'trial%': Number((row.trialSpread * 100).toFixed(1))
      }
    }
    console.table(table)
  }

  console.log('\n== ns/op summary ==')
  const summary = {}
  for (const entry of selectedMembranes) {
    const row = byMembrane[entry.name]
    if (!row) continue
    const line = {}
    for (const suite of selectedSuites) {
      const record = row[suite.name]
      line[suite.name] = record ? Number(record.nsPerOp.toFixed(1)) : null
    }
    summary[entry.name] = line
  }
  console.table(summary)

  if (Object.keys(startup).length) {
    console.log('\n== startup (ms, median of fresh processes) ==')
    const table = {}
    for (const [name, s] of Object.entries(startup)) {
      table[name] = {
        import: Number(s.importMs.toFixed(2)),
        construct: Number(s.constructMs.toFixed(2)),
        'first bridge': Number(s.firstBridgeMs.toFixed(3)),
        'construct #2': Number(s.secondConstructMs.toFixed(3)),
        'ready total': Number(s.readyMs.toFixed(2))
      }
    }
    console.table(table)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
