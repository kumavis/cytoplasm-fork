// Timeseries report over everything stored in perf/results/.
//
//   node perf/report.js                 # markdown timeseries to stdout
//   node perf/report.js --membrane cytoplasm:readOnly
//   node perf/report.js --json          # machine readable
//
// Every recorded run is a data point, including the experiments that were
// measured and then reverted - the point of keeping them is to be able to see
// which ideas did not pay off.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readdirSync, readFileSync } from 'fs'

const here = dirname(fileURLToPath(import.meta.url))
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

export function loadRuns () {
  let files
  try {
    files = readdirSync(resultsDir).filter(f => f.endsWith('.json')).sort()
  } catch (err) {
    return []
  }
  return files.map(file => ({
    file,
    ...JSON.parse(readFileSync(join(resultsDir, file), 'utf8'))
  }))
}

export function suiteNamesFor (runs, membraneName) {
  const suiteNames = []
  for (const run of runs) {
    for (const c of run.cases) {
      if (c.membrane === membraneName && !suiteNames.includes(c.suite)) suiteNames.push(c.suite)
    }
  }
  return suiteNames
}

export function seriesFor (runs, membraneName) {
  const suiteNames = suiteNamesFor(runs, membraneName)
  return { suiteNames, rows: runs.map(run => buildRow(run, membraneName, suiteNames)) }
}

function buildRow (run, membraneName, suiteNames) {
  const row = {
    label: run.label,
    notes: run.notes,
    sha: run.git.shortSha,
    timestamp: run.timestamp
  }
  for (const suite of suiteNames) {
    const record = run.cases.find(c => c.membrane === membraneName && c.suite === suite)
    row[suite] = record ? record.nsPerOp : null
  }
  const startup = run.startup && run.startup[membraneName]
  row.startupMs = startup ? startup.readyMs : null
  row.constructMs = startup ? startup.constructMs : null
  return row
}

function pct (first, value) {
  if (first == null || value == null || first === 0) return ''
  const change = (value / first - 1) * 100
  const sign = change > 0 ? '+' : ''
  return `${sign}${change.toFixed(0)}%`
}

function markdownTable (headers, rows) {
  const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i] ?? '').length)))
  const line = (cells) => `| ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ')} |`
  const sep = `|${widths.map(w => '-'.repeat(w + 2)).join('|')}|`
  return [line(headers), sep, ...rows.map(line)].join('\n')
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const runs = loadRuns()
  if (!runs.length) {
    console.error('no results recorded yet - run `node perf/run.js --save --label <name>`')
    process.exit(1)
  }

  if (args.json) {
    console.log(JSON.stringify(runs, null, 2))
    return
  }

  const membraneNames = args.membrane
    ? [String(args.membrane)]
    : ['cytoplasm:transparent', 'cytoplasm:readOnly']

  for (const membraneName of membraneNames) {
    const { suiteNames, rows } = seriesFor(runs, membraneName)
    if (!suiteNames.length) continue
    const first = rows[0]

    console.log(`\n### ${membraneName} - nanoseconds per operation (lower is better)\n`)
    const headers = ['#', 'label', ...suiteNames, 'startup ms']
    const body = rows.map((row, index) => [
      index,
      row.label,
      ...suiteNames.map(s => row[s] == null ? '-' : row[s].toFixed(1)),
      row.startupMs == null ? '-' : row.startupMs.toFixed(2)
    ])
    console.log(markdownTable(headers, body))

    console.log(`\n### ${membraneName} - change vs. run 0 (${first.label})\n`)
    const deltaBody = rows.map((row, index) => [
      index,
      row.label,
      ...suiteNames.map(s => pct(first[s], row[s]) || '-'),
      pct(first.startupMs, row.startupMs) || '-'
    ])
    console.log(markdownTable(headers, deltaBody))
  }
}

if (process.argv[1] && process.argv[1].endsWith('report.js')) {
  main()
}
