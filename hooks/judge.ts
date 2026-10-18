import type { EngineInterface } from 'claude-code'

import type { CaseResult, RunReport, Spec } from '../types'

export const STRUCTURES_TS = `// Shared by every solution: import what a problem needs, e.g.
//   import { ListNode } from '../lib/structures.ts'
export class ListNode {
  val: number
  next: ListNode | null
  constructor(val?: number, next?: ListNode | null) {
    this.val = val ?? 0
    this.next = next ?? null
  }
}

export class TreeNode {
  val: number
  left: TreeNode | null
  right: TreeNode | null
  constructor(val?: number, left?: TreeNode | null, right?: TreeNode | null) {
    this.val = val ?? 0
    this.left = left ?? null
    this.right = right ?? null
  }
}
`

// Runs under plain node on the host, not in the plugin's environment.
export const RUNNER_MJS = `import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { inspect } from 'node:util'
import { ListNode, TreeNode } from './structures.ts'

const [dir, target, which] = process.argv.slice(2)
const spec = JSON.parse(readFileSync(dir + '/.leet/spec.json', 'utf8'))
const file = target === 'reference' ? dir + '/.leet/reference.ts' : dir + '/solution.ts'
const done = payload => process.stdout.write('\\n__LEET__' + JSON.stringify(payload) + '\\n')

// console output, kept per case (-1: while the file loads). Each line also goes to stderr at once,
// so a case killed for hanging still shows what it printed.
const LOG_CAP = 8000
let logs = []
let logChars = 0
let caseIndex = -1
const show = p => typeof p === 'string' ? p : inspect(p, { depth: 4, breakLength: Infinity, maxArrayLength: 200 })
const capture = (...parts) => {
  if (logChars > LOG_CAP) return
  const line = parts.map(show).join(' ')
  logChars += line.length + 1
  const kept = logChars > LOG_CAP ? '… output cut at ' + LOG_CAP + ' characters' : line
  logs.push(kept)
  process.stderr.write('__LEET_LOG ' + caseIndex + ' ' + JSON.stringify(kept) + '\\n')
}
for (const k of ['log', 'info', 'warn', 'error', 'debug']) console[k] = capture

let mod
try {
  mod = await import(pathToFileURL(file).href)
} catch (error) {
  done({ compileError: String(error && error.stack || error).split('\\n').slice(0, 8).join('\\n') })
  process.exit(0)
}
const loadLogs = logs.length ? logs.join('\\n') : undefined

const toList = a => { let head = null; for (let i = (a || []).length - 1; i >= 0; i--) head = new ListNode(a[i], head); return head }
const fromList = n => { const out = []; let guard = 0; while (n && guard++ < 200000) { out.push(n.val); n = n.next } return out }
const toTree = a => {
  if (!a || a.length === 0 || a[0] === null) return null
  const root = new TreeNode(a[0]); const queue = [root]; let i = 1
  while (queue.length && i < a.length) {
    const node = queue.shift()
    if (i < a.length && a[i] !== null) { node.left = new TreeNode(a[i]); queue.push(node.left) } i++
    if (i < a.length && a[i] !== null) { node.right = new TreeNode(a[i]); queue.push(node.right) } i++
  }
  return root
}
const fromTree = root => {
  if (!root) return []
  const out = []; const queue = [root]
  while (queue.length) { const n = queue.shift(); if (n) { out.push(n.val); queue.push(n.left || null, n.right || null) } else out.push(null) }
  while (out.length && out[out.length - 1] === null) out.pop()
  return out
}
const toStruct = (v, s) => s === 'list' ? toList(v) : s === 'tree' ? toTree(v) : s === 'listArray' ? (v || []).map(toList) : v
const fromStruct = (v, s) => s === 'list' ? fromList(v) : s === 'tree' ? fromTree(v) : s === 'listArray' ? (v || []).map(fromList) : v

const canon = v => { try { return JSON.stringify(v === undefined ? null : v) } catch { return String(v) } }
const cut = (s, n) => s.length > n ? s.slice(0, n) + ' …(' + (s.length - n) + ' more chars)' : s
const sortAll = a => Array.isArray(a) ? [...a].sort((x, y) => canon(x) < canon(y) ? -1 : canon(x) > canon(y) ? 1 : 0) : a
const norm = (v, mode) => mode === 'unordered' ? sortAll(v) : mode === 'unorderedDeep' ? sortAll(Array.isArray(v) ? v.map(sortAll) : v) : v
const close = (a, b) => typeof a === 'number' && typeof b === 'number'
  ? Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b))
  : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => close(x, b[i])) : canon(a) === canon(b)
const isEqual = (got, want) => spec.compare === 'float' ? close(got, want) : canon(norm(got, spec.compare)) === canon(norm(want, spec.compare))

const cases = which === 'examples' ? spec.examples : [...spec.examples, ...spec.tests]
const results = []
for (let i = 0; i < cases.length; i++) {
  const t = cases[i]
  logs = []
  logChars = 0
  caseIndex = i
  process.stderr.write('__LEET_START ' + i + '\\n')
  let got, error, input
  const t0 = performance.now()
  try {
    if (spec.kind === 'class') {
      input = 'ops  = ' + canon(t.ops) + '\\nargs = ' + canon(t.args)
      const Cls = mod[spec.className]
      if (typeof Cls !== 'function') throw new Error('solution must export class ' + spec.className)
      const obj = new Cls(...structuredClone(t.args[0] || []))
      got = [null]
      for (let k = 1; k < t.ops.length; k++) {
        if (typeof obj[t.ops[k]] !== 'function') throw new Error(spec.className + ' has no method ' + t.ops[k])
        const r = obj[t.ops[k]](...structuredClone(t.args[k] || []))
        got.push(r === undefined ? null : r)
      }
    } else {
      const args = t.gen ? new Function('return (' + t.gen + ')')() : structuredClone(t.args)
      input = t.gen ? '(' + t.label + ')' : spec.params.map((p, j) => p.name + ' = ' + canon(args[j])).join(', ')
      const fn = mod[spec.functionName]
      if (typeof fn !== 'function') throw new Error('solution must export function ' + spec.functionName)
      const conv = args.map((a, j) => toStruct(a, spec.params[j] && spec.params[j].struct))
      const r = fn(...conv)
      got = spec.mutates !== undefined && spec.mutates !== null
        ? fromStruct(conv[spec.mutates], spec.params[spec.mutates] && spec.params[spec.mutates].struct)
        : fromStruct(r, spec.returns.struct)
    }
  } catch (e) {
    error = String(e && e.stack || e).split('\\n').filter(l => !l.includes('/lib/runner.mjs')).slice(0, 6).join('\\n')
  }
  const ms = performance.now() - t0
  const want = spec.expected ? spec.expected[i] : undefined
  results.push({
    index: i,
    isPass: target === 'reference' ? !error : !error && isEqual(got, want),
    input: cut(input || '', 400),
    expected: target === 'reference' ? undefined : cut(canon(want), 400),
    got: error ? undefined : cut(canon(got), 400),
    raw: target === 'reference' ? (got === undefined ? null : got) : undefined,
    error,
    ms: Math.round(ms * 100) / 100,
    logs: logs.length ? logs.join('\\n') : undefined,
  })
}
done({ results, loadLogs })
`

// Set once at session start; the host decides how a hung run can be killed.
export const platform = { isWindows: false }

type Run = { compileError?: string; results?: (CaseResult & { raw?: unknown })[]; loadLogs?: string }

// What the runner printed during one case, read back from its stderr stream.
const streamedLogs = (stderr: string, index: number) => {
  const lines = [...stderr.matchAll(/^__LEET_LOG (-?\d+) (.*)$/gm)]
    .filter(m => Number(m[1]) === index)
    .map(m => {
      try {
        return String(JSON.parse(m[2] ?? '""'))
      } catch {
        return m[2] ?? ''
      }
    })

  return lines.length ? lines.join('\n') : undefined
}

const parse = (stdout: string): Run | undefined => {
  const line = stdout.split('\n').find(l => l.startsWith('__LEET__'))

  return line === undefined ? undefined : (JSON.parse(line.slice('__LEET__'.length)) as Run)
}

export async function runNode(
  $: EngineInterface,
  root: string,
  dir: string,
  target: 'solution' | 'reference',
  which: 'examples' | 'all',
): Promise<Run & { hungAt?: number; hungLogs?: string; crash?: string }> {
  const node = ['node', '--experimental-transform-types', '--no-warnings', `${root}/lib/runner.mjs`, dir, target, which]
  // Coreutils `timeout` kills a hung run but keeps its output, which names the test that hung. Windows has no such tool.
  const argv = platform.isWindows ? node : ['timeout', '-s', 'KILL', '15', ...node]
  let ran: Awaited<ReturnType<typeof $.process.run>>
  try {
    ran = await $.process.run(argv, { cwd: dir, timeoutMs: platform.isWindows ? 15_000 : 25_000 })
  } catch (error) {
    return { hungAt: -1, crash: error instanceof Error ? error.message : String(error) }
  }
  const run = parse(ran.stdout)
  if (run) return run
  const starts = [...ran.stderr.matchAll(/__LEET_START (\d+)/g)]
  const last = starts[starts.length - 1]
  if (ran.exitCode === 124 || ran.exitCode === 137) {
    const hungAt = last ? Number(last[1]) : 0

    return { hungAt, hungLogs: streamedLogs(ran.stderr, hungAt), loadLogs: streamedLogs(ran.stderr, -1) }
  }
  const stderr = ran.stderr.replace(/^__LEET_(START|LOG) .*\n/gm, '').trim()

  return { crash: stderr.slice(0, 2000) || `node exited ${ran.exitCode}` }
}

// A case far slower than the reference is a Time Limit Exceeded, as on LeetCode.
const isTooSlow = (ms: number, refMs: number | undefined) =>
  refMs !== undefined && ms > Math.max(1000, refMs * 25)

export async function judge(
  $: EngineInterface,
  root: string,
  dir: string,
  spec: Spec,
  kind: 'run' | 'submit',
  now: number,
): Promise<RunReport> {
  const which = kind === 'run' ? 'examples' : 'all'
  const total = kind === 'run' ? spec.examples.length : spec.examples.length + spec.tests.length
  const base = { kind, total, at: now, passed: 0, cases: [] as CaseResult[], ms: 0 }
  const run = await runNode($, root, dir, 'solution', which)

  if (run.compileError !== undefined) {
    return { ...base, verdict: 'Compile Error', compileError: run.compileError }
  }
  if (run.hungAt !== undefined) {
    const isKnown = run.hungAt >= 0
    const failing: CaseResult = {
      index: Math.max(0, run.hungAt),
      isPass: false,
      input: isKnown ? `test ${run.hungAt + 1}` : 'one of the tests',
      ms: 15000,
      error: isKnown ? 'Killed after 15 s' : `Stopped after 15 s (${run.crash ?? 'no output'})`,
      logs: run.hungLogs,
    }

    return { ...base, verdict: 'Time Limit Exceeded', passed: Math.max(0, run.hungAt), failing, loadLogs: run.loadLogs }
  }
  if (run.results === undefined) {
    return { ...base, verdict: 'Runtime Error', compileError: run.crash }
  }

  const cases = run.results.map(({ raw: _raw, ...c }) => c)
  const ms = Math.round(cases.reduce((sum, c) => sum + c.ms, 0))
  const failing = cases.find(c => !c.isPass || isTooSlow(c.ms, spec.refMs?.[c.index]))
  const passed = cases.filter(c => c.isPass).length
  const loadLogs = run.loadLogs
  if (failing === undefined) return { ...base, verdict: 'Accepted', passed, cases, ms, loadLogs }
  const verdict =
    failing.error !== undefined ? 'Runtime Error' : failing.isPass ? 'Time Limit Exceeded' : 'Wrong Answer'

  return { ...base, verdict, passed, cases, ms, failing, loadLogs }
}

// Fills `expected` and `refMs` by running the reference solution; a test it fails on is dropped.
export async function computeExpected(
  $: EngineInterface,
  root: string,
  dir: string,
  spec: Spec,
): Promise<{ spec: Spec } | { error: string }> {
  const run = await runNode($, root, dir, 'reference', 'all')
  if (run.compileError !== undefined) return { error: `reference does not load: ${run.compileError}` }
  if (run.results === undefined) return { error: `reference crashed: ${run.crash ?? `hung on test ${run.hungAt}`}` }
  const results = run.results
  const examplesOk = results.slice(0, spec.examples.length).every(r => r.isPass)
  if (!examplesOk) return { error: 'reference fails on an example' }

  const kept = spec.tests.filter((_, i) => results[spec.examples.length + i]?.isPass)
  const keptResults = results.filter(r => r.isPass)

  return {
    spec: {
      ...spec,
      tests: kept,
      expected: keptResults.map(r => r.raw ?? null),
      refMs: keptResults.map(r => r.ms),
    },
  }
}
