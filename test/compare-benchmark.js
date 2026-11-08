#!/usr/bin/env node

// Compares Nano ID speed between the current files and other Nano ID copy
// (like the PR base branch on CI):
//
//   node test/compare-benchmark.js ../nanoid-main
//
// CI runners are noisy, so both versions are loaded in the same process
// and measured in short alternating rounds. Each round compares versions
// right next to each other, so a slow moment on the runner affects both.

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Bench } from 'tinybench'

let baseDir = process.argv[2]
if (!baseDir) {
  process.stderr.write('Usage: node test/compare-benchmark.js BASE_DIR\n')
  process.exit(1)
}

const ROUNDS = Number(process.env.BENCHMARK_ROUNDS ?? 12)
const ROUND_TIME = Number(process.env.BENCHMARK_TIME ?? 200)
// Smaller diffs are usually just a noise of the machine
const THRESHOLD = Number(process.env.BENCHMARK_THRESHOLD ?? 2) / 100
// Fast functions take less time than reading the timer,
// so every task calls the function N times in a loop.
const N = 1000
// Keep the results, so V8 cannot skip creating the IDs
let out = []

async function load(dir) {
  let file = name => import(pathToFileURL(join(resolve(dir), name)).href)
  let [node, browser, nonSecure] = await Promise.all([
    file('index.js'),
    file('index.browser.js'),
    file('non-secure/index.js')
  ])
  let custom = node.customAlphabet('1234567890abcdef-', 21)
  return {
    'nanoid': node.nanoid,
    'customAlphabet': custom,
    'nanoid for browser': browser.nanoid,
    'nanoid/non-secure': nonSecure.nanoid
  }
}

let versions = {
  base: await load(baseDir),
  head: await load(join(import.meta.dirname, '..'))
}
let names = Object.keys(versions.head)

let opsPerSec = {}
for (let name of names) opsPerSec[name] = { base: [], head: [] }

for (let round = 0; round < ROUNDS; round++) {
  let bench = new Bench({
    iterations: 1,
    time: ROUND_TIME,
    // JIT stays warm between rounds
    warmup: round === 0
  })
  // Alternate the order to avoid advantage of the first task
  let order = round % 2 === 0 ? ['base', 'head'] : ['head', 'base']
  for (let name of names) {
    for (let version of order) {
      let fn = versions[version][name]
      bench.add(`${version}\t${name}`, () => {
        for (let i = 0; i < N; i++) out[i] = fn()
      })
    }
  }
  await bench.run()
  for (let task of bench.tasks) {
    let [version, name] = task.name.split('\t')
    opsPerSec[name][version].push((N * 1000) / task.result.latency.mean)
  }
  process.stderr.write(`Round ${round + 1}/${ROUNDS}\n`)
}

function quantile(list, q) {
  let sorted = list.toSorted((a, b) => a - b)
  let pos = (sorted.length - 1) * q
  let low = Math.floor(pos)
  let high = Math.ceil(pos)
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low)
}

function percent(ratio) {
  let value = (ratio - 1) * 100
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function formatOps(value) {
  return Math.round(value).toLocaleString('en-US')
}

let rows = names.map(name => {
  let { base, head } = opsPerSec[name]
  // Compare versions inside the same round
  let ratios = head.map((value, i) => value / base[i])
  let median = quantile(ratios, 0.5)
  let low = quantile(ratios, 0.25)
  let high = quantile(ratios, 0.75)
  let verdict = 'same'
  if (low > 1 && median > 1 + THRESHOLD) verdict = '🟢 faster'
  if (high < 1 && median < 1 - THRESHOLD) verdict = '🔴 slower'
  return [
    name,
    formatOps(quantile(base, 0.5)),
    formatOps(quantile(head, 0.5)),
    percent(median),
    `${percent(low)} … ${percent(high)}`,
    verdict
  ]
})

let header = ['', 'base ops/sec', 'PR ops/sec', 'diff', 'noise', '']
let lines = [
  '## Benchmark',
  '',
  `| ${header.join(' | ')} |`,
  '| :-- | --: | --: | --: | :-: | :-- |',
  ...rows.map(row => `| ${row.join(' | ')} |`),
  '',
  `Median of ${ROUNDS} alternating rounds on Node.js ${process.version}. ` +
    '“Noise” is the middle half of per-round diffs. ' +
    'The change is marked only when the whole range is on one side ' +
    `of zero and the diff is bigger than ${THRESHOLD * 100}%.`,
  ''
]
process.stdout.write(lines.join('\n'))
