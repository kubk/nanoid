#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { Bench } from 'tinybench'

let baseDir = process.argv[2]
if (!baseDir) {
  process.stderr.write('Usage: node test/compare-benchmark.js BASE_DIR\n')
  process.exit(1)
}

const ROUNDS = 30
const ROUND_TIME = 100
const THRESHOLD = 0.02
const N = 1000
let out = []

setFlagsFromString('--expose-gc')
let gc = runInNewContext('gc')

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
    setup: () => gc(),
    time: ROUND_TIME,
    warmup: round === 0
  })
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

let slower = []
let rows = names.map(name => {
  let { base, head } = opsPerSec[name]
  let ratios = head.map((value, i) => value / base[i])
  let median = quantile(ratios, 0.5)
  let low = quantile(ratios, 0.25)
  let high = quantile(ratios, 0.75)
  process.stderr.write(
    `DIAG\t${name}\t${percent(low)}\t${percent(median)}\t${percent(high)}\n`
  )
  let verdict = 'same'
  if (low > 1 && median > 1 + THRESHOLD) verdict = '🟢 faster'
  if (high < 1 && median < 1 - THRESHOLD) {
    verdict = '🔴 slower'
    slower.push(`${name} is ${percent(median).slice(1)} slower`)
  }
  return [
    name,
    formatOps(quantile(base, 0.5)),
    formatOps(quantile(head, 0.5)),
    percent(median),
    verdict
  ]
})

let header = ['', 'base ops/sec', 'PR ops/sec', 'diff', '']
let lines = [
  '## Benchmark',
  '',
  `| ${header.join(' | ')} |`,
  '| :-- | --: | --: | --: | :-- |',
  ...rows.map(row => `| ${row.join(' | ')} |`),
  '',
  `Median of ${ROUNDS} alternating rounds on Node.js ${process.version}. ` +
    `Changes smaller than ${THRESHOLD * 100}% are marked as the same.`,
  ''
]
process.stdout.write(lines.join('\n'))

if (slower.length > 0) {
  let prefix = process.env.GITHUB_ACTIONS ? '::error::' : ''
  for (let message of slower) process.stdout.write(`\n${prefix}${message}`)
  process.stdout.write('\n')
  process.exit(1)
}
