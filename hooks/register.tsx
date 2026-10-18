import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type {
  CatalogEntry,
  ChatMessage,
  Difficulty,
  Open,
  ProblemFile,
  Progress,
  RunReport,
  Submission,
  Tab,
  TestCase,
  View,
} from '../types'
import { explainBack, generateProblem, reviewAccepted, tutorReply, writeEditorial } from './ai'
import { BY_SLUG, CATALOG, DIFFICULTIES, PATTERNS, dirName, patternFile } from './catalog'
import { RUNNER_MJS, STRUCTURES_TS, computeExpected, judge, platform } from './judge'
import {
  dueReviews,
  emptyProgress,
  ensureDaily,
  patternStats,
  pickNext,
  recordAccepted,
  recordExplained,
  recordFailedSubmit,
  recordGiveUp,
  recordOpened,
  recordReviewStart,
  recordTimer,
  recordTutorAsk,
  shownStreak,
  solvedCounts,
  unlockedLevels,
  unlockedPatterns,
} from './progress'

const PANE = 'leet'
const STORE_KEY = 'progress'
const BAND_KEY = 'bandHiddenDay'
const INTERVIEW_MINUTES: Record<Difficulty, number> = { Easy: 20, Medium: 35, Hard: 50 }
// LeetCode's own URL slug, where it differs from the title's.
const LC_SLUG: Record<string, string> = { 'pow-x-n': 'powx-n' }

const DEFAULT_VIEW: View = {
  tab: 'home',
  listDifficulty: 'all',
  listPattern: 'all',
  listStatus: 'all',
  nextLevel: 'roadmap',
  submissionIndex: null,
  consoleCase: null,
  notebookPattern: null,
  isConfirmingGiveUp: false,
  isStatementHidden: false,
  isCustomEditorForced: false,
}

const progressAtom = atom({ plugin: 'leet', key: 'progress' } as const, emptyProgress())
const todayAtom = atom({ plugin: 'leet', key: 'today' } as const, '')
const viewAtom = atom({ plugin: 'leet', key: 'view' } as const, DEFAULT_VIEW)
const openAtom = atom({ plugin: 'leet', key: 'open' } as const, null)
const busyAtom = atom({ plugin: 'leet', key: 'busy' } as const, null)
const tickAtom = atom({ plugin: 'leet', key: 'tick' } as const, 0)
const hubAtom = atom({ plugin: 'leet', key: 'isHubOpen' } as const, false)
const bandAtom = atom({ plugin: 'leet', key: 'bandHiddenDay' } as const, '')
const notebookAtom = atom({ plugin: 'leet', key: 'notebook' } as const, '')
const faultsAtom = atom({ plugin: 'leet', key: 'editorFaults' } as const, {})

type $ = EngineInterface

const canon = (v: unknown) => JSON.stringify(v === undefined ? null : v)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

let root = ''
// The editor's latest text, written to solution.ts shortly after typing stops.
let draft: { slug: string; dir: string; version: number; text: string } | null = null
let draftTimer: { cancel: () => void } | undefined
// What solution.ts last held as far as the hub knows, to notice edits made in another editor.
const known = new Map<string, string>()
let watcher: { cancel: () => void } | undefined
let ticker: { cancel: () => void } | undefined
const generating = new Map<string, Promise<void>>()

// Asks the host for the local date: the plugin's own clock may not know the time zone.
const today = async ($: $) => {
  const argv = platform.isWindows
    ? ['powershell.exe', '-NoProfile', '-Command', 'Get-Date -Format yyyy-MM-dd']
    : ['date', '+%F']
  const ran = await $.process.run(argv).catch(() => undefined)
  const day = ran?.stdout.trim() ?? ''

  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date(await $.clock.now()).toISOString().slice(0, 10)
}

const saveDraft = ($: $, open: Open, text: string) => {
  // A field that flattens text (the desktop app's one-line box did) must never overwrite multi-line code.
  const before = known.get(open.slug) ?? open.code
  const flat = before.replace(/\n/g, '')
  if (!text.includes('\n') && before.includes('\n') && text.startsWith(flat.slice(0, Math.min(20, flat.length)))) {
    $.ui.toast('Not saved: that edit lost the line breaks of your code.')
    return
  }
  draft = { slug: open.slug, dir: open.dir, version: open.codeVersion, text }
  draftTimer?.cancel()
  draftTimer = $.clock.after(600, () => void flushDraft($).catch(() => undefined))
}

const flushDraft = async ($: $) => {
  draftTimer?.cancel()
  draftTimer = undefined
  const pending = draft
  draft = null
  if (!pending) return
  await $.fs.write(`${pending.dir}/solution.ts`, pending.text)
  known.set(pending.slug, pending.text)
  // The hub's copy follows the editor, so an editor drawn again (after a tab switch) starts from it.
  // The version stays: a new one would reset the editor that is still typing.
  await setOpen($, o => (o.slug === pending.slug ? { code: pending.text } : {}))
}

// Shows solution.ts in the editor again when another editor changed it and nothing typed here is pending.
const syncFromDisk = async ($: $) => {
  const open = await read($, openAtom)
  if (!open || draft !== null) return
  const text = await $.fs.read(`${open.dir}/solution.ts`).catch(() => undefined)
  if (text === undefined || text === known.get(open.slug)) return
  known.set(open.slug, text)
  await setOpen($, o => ({ code: text, codeVersion: o.codeVersion + 1 }))
}

const watchFile = ($: $) => {
  watcher?.cancel()
  watcher = $.clock.every(2000, () => void syncFromDisk($).catch(() => undefined))
}
const problemDir = (entry: CatalogEntry) => `${root}/${dirName(entry)}`
const git = ($: $, args: string[]) => $.process.run(['git', '-C', root, ...args]).catch(() => undefined)
const readJson = async <T,>($: $, path: string, fallback: T): Promise<T> =>
  (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as T) : fallback

const saveProgress = async ($: $, change: (p: Progress) => Progress) => {
  const next = await update($, progressAtom, change)
  await $.store.set(STORE_KEY, next)

  return next
}
const setView = ($: $, change: Partial<View>) => update($, viewAtom, v => ({ ...v, ...change }))
const setOpen = ($: $, change: (o: Open) => Partial<Open>) =>
  update($, openAtom, o => (o === null ? null : { ...o, ...change(o) }))

// Runs one piece of work at a time behind the busy line; a failure lands in a toast.
const busy = async ($: $, label: string, work: () => Promise<void>) => {
  if ((await read($, busyAtom)) !== null) {
    $.ui.toast('Still working on the last step…')
    return
  }
  await update($, busyAtom, () => label)
  try {
    await work()
  } catch (error) {
    $.ui.toast(`LeetCode: ${errorText(error)}`, { timeoutMs: 8000 })
  } finally {
    await update($, busyAtom, () => null)
  }
}

const ensureWorkspace = async ($: $) => {
  await $.fs.write(`${root}/lib/structures.ts`, STRUCTURES_TS)
  await $.fs.write(`${root}/lib/runner.mjs`, RUNNER_MJS)
  const seed: Record<string, string> = {
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          module: 'nodenext',
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          lib: ['es2023'],
        },
      },
      null,
      2,
    )}\n`,
    '.gitignore': '*/.leet/tutor.json\n',
    'README.md': '# LeetCode practice\n\nSolved in Claude Code with the `leet` mod: one folder per problem, pattern cards in `patterns/`.\n',
  }
  for (const [name, text] of Object.entries(seed)) {
    if (!(await $.fs.exists(`${root}/${name}`))) await $.fs.write(`${root}/${name}`, text)
  }
  if (!(await $.fs.exists(`${root}/.git`))) await git($, ['init', '-q'])
}

const formatArgs = (file: ProblemFile, c: TestCase) => {
  if ('ops' in c) return `${canon(c.ops)}\n${canon(c.args)}`
  if ('gen' in c) return `(${c.label})`

  return file.spec.params.map((p, j) => `${p.name} = ${canon(c.args[j])}`).join(', ')
}

const statementMarkdown = (file: ProblemFile) => {
  const examples = file.spec.examples.map((c, i) => {
    const explanation = 'explanation' in c && c.explanation ? `\nExplanation: ${c.explanation}` : ''

    return `**Example ${i + 1}**\n\n\`\`\`\nInput:  ${formatArgs(file, c)}\nOutput: ${canon(file.spec.expected?.[i])}${explanation}\n\`\`\``
  })
  const constraints = file.spec.constraints.map(c => `- \`${c}\``).join('\n')
  const followUp = file.spec.followUp ? `\n\n**Follow-up:** ${file.spec.followUp}` : ''

  return `${file.statement}\n\n${examples.join('\n\n')}\n\n**Constraints**\n\n${constraints}${followUp}`
}

const loadOpen = async ($: $, slug: string) => {
  const entry = BY_SLUG[slug]
  if (!entry) return
  const dir = problemDir(entry)
  const file = await readJson<ProblemFile | null>($, `${dir}/.leet/problem.json`, null)
  if (file === null) return
  const rec = (await read($, progressAtom)).problems[slug]
  const editorialPath = `${dir}/EDITORIAL.md`
  const open: Open = {
    slug,
    file,
    dir,
    report: null,
    review: (await $.fs.exists(`${dir}/.leet/review.md`)) ? await $.fs.read(`${dir}/.leet/review.md`) : null,
    editorial: rec?.isEditorialUnlocked && (await $.fs.exists(editorialPath)) ? await $.fs.read(editorialPath) : null,
    chat: await readJson<ChatMessage[]>($, `${dir}/.leet/tutor.json`, []),
    submissions: await readJson<Submission[]>($, `${dir}/.leet/submissions.json`, []),
    question: null,
    code: await $.fs.read(`${dir}/solution.ts`),
    codeVersion: 1,
  }
  known.set(slug, open.code)
  const last = open.submissions[open.submissions.length - 1]
  open.report = last ?? null
  if (rec?.status === 'solved' && !rec.hasExplained) {
    open.question = [...open.chat].reverse().find(m => m.role === 'tutor' && m.text.startsWith('**Explain it back:**'))
      ?.text.replace('**Explain it back:** ', '') ?? null
  }
  await flushDraft($)
  await update($, openAtom, () => open)
  await startTicker($)
  watchFile($)
}

const generate = ($: $, entry: CatalogEntry) => {
  const running = generating.get(entry.slug)
  if (running) return running
  const work = (async () => {
    await ensureWorkspace($)
    const dir = problemDir(entry)
    let note: string | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const made = await generateProblem($, entry, note)
        await $.fs.write(`${dir}/.leet/reference.ts`, made.reference)
        await $.fs.write(`${dir}/.leet/spec.json`, JSON.stringify(made.spec))
        const checked = await computeExpected($, root, dir, made.spec)
        if ('error' in checked) {
          note = checked.error
          continue
        }
        const file: ProblemFile = {
          entry,
          statement: made.statement,
          starter: made.starter,
          spec: checked.spec,
          createdAt: await $.clock.now(),
        }
        await $.fs.write(`${dir}/.leet/spec.json`, JSON.stringify(checked.spec))
        if (!(await $.fs.exists(`${dir}/solution.ts`))) await $.fs.write(`${dir}/solution.ts`, made.starter)
        const url = `https://leetcode.com/problems/${LC_SLUG[entry.slug] ?? entry.slug}/`
        await $.fs.write(
          `${dir}/README.md`,
          `# ${entry.id}. ${entry.title}\n\n**${entry.difficulty}** · ${entry.pattern} · [LeetCode](${url})\n\n${statementMarkdown(file)}\n`,
        )
        await $.fs.write(`${dir}/.leet/problem.json`, JSON.stringify(file, null, 2))

        return
      } catch (error) {
        note = errorText(error)
      }
    }
    throw new Error(`could not prepare ${entry.title}: ${note}`)
  })()
  generating.set(entry.slug, work)
  work.finally(() => generating.delete(entry.slug)).catch(() => undefined)

  return work
}

const isGenerated = async ($: $, entry: CatalogEntry) =>
  root !== '' && $.fs.exists(`${problemDir(entry)}/.leet/problem.json`)

const openProblem = ($: $, slug: string) =>
  busy($, `Preparing #${BY_SLUG[slug]?.id} ${BY_SLUG[slug]?.title}… (Claude writes the problem and tests)`, async () => {
    const entry = BY_SLUG[slug]
    if (!entry) return
    if (!(await isGenerated($, entry))) await generate($, entry)
    await loadOpen($, slug)
    await setView($, { tab: 'problem', submissionIndex: null, isConfirmingGiveUp: false })
  })

const openHub = async ($: $) => {
  await update($, hubAtom, () => true)

  return $.ui.open({ id: PANE, title: 'LeetCode', focus: true })
}

const refreshDay = async ($: $) => {
  const day = await today($)
  if (day === (await read($, todayAtom))) return
  await update($, todayAtom, () => day)
  const progress = await saveProgress($, p => ensureDaily(p, day))
  const daily = progress.daily && BY_SLUG[progress.daily.slug]
  // Have today's problem ready before it is opened.
  if (daily && !(await isGenerated($, daily))) {
    generate($, daily).catch(error => $.ui.log(`leet: could not prepare today's problem: ${errorText(error)}`, { to: 'debug' }))
  }
}

const startTicker = async ($: $) => {
  ticker?.cancel()
  ticker = undefined
  const open = await read($, openAtom)
  const timer = open && (await read($, progressAtom)).problems[open.slug]?.timer
  if (!open || !timer || timer.isTimeUp) return
  ticker = $.clock.every(1000, async () => {
    const now = await $.clock.now()
    await update($, tickAtom, () => now)
    const current = (await read($, progressAtom)).problems[open.slug]?.timer
    if (current && !current.isTimeUp && now - current.startedAt >= current.limitMs) {
      await saveProgress($, p => recordTimer(p, open.slug, { ...current, isTimeUp: true }))
      $.ui.toast("Time's up! The tutor is available again.", { timeoutMs: 8000 })
      ticker?.cancel()
    }
  })
}

const saveSubmissions = ($: $, open: Open, submissions: Submission[]) =>
  $.fs.write(`${open.dir}/.leet/submissions.json`, JSON.stringify(submissions.slice(-50)))

const saveChat = ($: $, open: Open, chat: ChatMessage[]) =>
  $.fs.write(`${open.dir}/.leet/tutor.json`, JSON.stringify(chat))

const appendChat = async ($: $, message: ChatMessage) => {
  const open = await setOpen($, o => ({ chat: [...o.chat, message] }))
  if (open) await saveChat($, open, open.chat)
}

const runCode = ($: $, kind: 'run' | 'submit') =>
  busy($, kind === 'run' ? 'Running the examples…' : 'Running every test…', async () => {
    const open = await read($, openAtom)
    if (!open) return
    await ensureWorkspace($)
    await flushDraft($)
    await syncFromDisk($)
    const code = await $.fs.read(`${open.dir}/solution.ts`)
    const report = await judge($, root, open.dir, open.file.spec, kind, await $.clock.now())
    const submissions = [...open.submissions, { ...report, code }]
    await setOpen($, () => ({ report, submissions }))
    await saveSubmissions($, open, submissions)
    if (kind === 'run') return

    const day = await read($, todayAtom)
    if (report.verdict !== 'Accepted') {
      await saveProgress($, p => recordFailedSubmit(p, open.slug))
      return
    }

    let outcome: ReturnType<typeof recordAccepted> | undefined
    await saveProgress($, p => {
      outcome = recordAccepted(p, open.slug, day, report.at)
      return outcome.progress
    })
    ticker?.cancel()
    const entry = open.file.entry
    await git($, ['add', '-A', '--', dirName(entry), 'lib', 'tsconfig.json', 'README.md', '.gitignore'])
    await git($, ['commit', '-q', '-m', `Solve ${entry.id}. ${entry.title} (${entry.difficulty}, ${entry.pattern})`])
    const unlocked = outcome?.unlocked ?? []
    const news = [
      outcome?.isStreakDay ? `🔥 Daily done, streak ${outcome.progress.streak.count}` : undefined,
      ...unlocked.map(u => `🔓 ${u.pattern}: ${u.level} unlocked`),
    ].filter(Boolean)
    $.ui.toast(['Accepted!', ...news].join('  ·  '), { timeoutMs: 8000 })

    await update($, busyAtom, () => 'Claude is reviewing your solution…')
    const { review, question } = await reviewAccepted($, open.file, code)
    await $.fs.write(`${open.dir}/.leet/review.md`, review)
    const rec = (await read($, progressAtom)).problems[open.slug]
    const isAsking = rec !== undefined && !rec.hasExplained
    await setOpen($, () => ({ review, question: isAsking ? question : null }))
    if (isAsking) await appendChat($, { role: 'tutor', text: `**Explain it back:** ${question}`, at: await $.clock.now() })
  })

// Starts the tutor over: the chat on screen, in tutor.json and in what the tutor is sent. An
// explain-back question still waiting for its answer stays, so the card can still be written.
const clearChat = async ($: $) => {
  const open = await read($, openAtom)
  if (!open) return
  const at = await $.clock.now()
  const kept: ChatMessage[] = open.question === null ? [] : [{ role: 'tutor', text: `**Explain it back:** ${open.question}`, at }]
  await setOpen($, () => ({ chat: kept, chatClearedAt: at }))
  await saveChat($, open, kept)
  $.ui.toast('Tutor chat cleared: the next question starts fresh.')
}

const sendToTutor = ($: $, text: string, isHint = false) =>
  busy($, 'Tutor is thinking…', async () => {
    const open = await read($, openAtom)
    const message = text.trim()
    if (!open || message === '') return
    if (message === '/clear') return clearChat($)
    const progress = await read($, progressAtom)
    const timer = progress.problems[open.slug]?.timer
    if (timer && !timer.isTimeUp) {
      $.ui.toast('The tutor is off until the interview timer ends.')
      return
    }
    await setView($, { tab: 'tutor' })
    await flushDraft($)
    const code = await $.fs.read(`${open.dir}/solution.ts`)
    await appendChat($, { role: 'you', text: message, at: await $.clock.now(), code, ...(isHint ? { isHint: true } : {}) })

    if (open.question !== null) {
      const { feedback, card } = await explainBack($, open.file, code, open.question, message)
      const path = `${root}/patterns/${patternFile(open.file.entry.pattern)}`
      const notebook = (await $.fs.exists(path)) ? await $.fs.read(path) : `# ${open.file.entry.pattern}\n`
      await $.fs.write(path, `${notebook.trimEnd()}\n\n${card}\n`)
      await saveProgress($, p => recordExplained(p, open.slug))
      await setOpen($, () => ({ question: null }))
      await appendChat($, { role: 'tutor', text: `${feedback}\n\n📒 Saved a card to your **${open.file.entry.pattern}** notebook.`, at: await $.clock.now() })
      await git($, ['add', '-A', '--', 'patterns'])
      await git($, ['commit', '-q', '-m', `Pattern card: ${open.file.entry.title}`])
      return
    }

    await saveProgress($, p => recordTutorAsk(p, open.slug))
    const reference = await $.fs.read(`${open.dir}/.leet/reference.ts`)
    const current = (await read($, openAtom)) ?? open
    // Each Hint pressed again on the same code goes one level more concrete, up to 3.
    let hintLevel = 0
    if (isHint) {
      const asked = current.chat.filter(m => m.role === 'you')
      let repeats = 0
      for (let i = asked.length - 2; i >= 0 && asked[i]!.isHint && asked[i]!.code === code; i--) repeats++
      hintLevel = Math.min(3, repeats + 1)
    }
    const reply = await tutorReply($, open.file, reference, code, current.report, current.chat, hintLevel)
    await appendChat($, { role: 'tutor', text: reply, at: await $.clock.now() })
  })

const showEditorial = ($: $) =>
  busy($, 'Claude is writing the editorial…', async () => {
    const open = await read($, openAtom)
    if (!open) return
    const path = `${open.dir}/EDITORIAL.md`
    if (!(await $.fs.exists(path))) {
      const reference = await $.fs.read(`${open.dir}/.leet/reference.ts`)
      await $.fs.write(path, await writeEditorial($, open.file, reference))
    }
    const editorial = await $.fs.read(path)
    await setOpen($, () => ({ editorial }))
  })

const giveUp = async ($: $) => {
  const open = await read($, openAtom)
  if (!open) return
  await setView($, { isConfirmingGiveUp: false })
  const day = await read($, todayAtom)
  await saveProgress($, p => recordGiveUp(p, open.slug, day))
  ticker?.cancel()
  await showEditorial($)
}

const restartReview = ($: $) =>
  busy($, 'Starting from a blank file…', async () => {
    const open = await read($, openAtom)
    if (!open) return
    const now = await $.clock.now()
    await flushDraft($)
    const old = await $.fs.read(`${open.dir}/solution.ts`)
    await $.fs.write(`${open.dir}/.leet/attempts/${now}.ts`, old)
    await $.fs.write(`${open.dir}/solution.ts`, open.file.starter)
    known.set(open.slug, open.file.starter)
    await saveProgress($, p => recordReviewStart(p, open.slug))
    await setOpen($, o => ({
      report: null,
      review: null,
      editorial: null,
      question: null,
      code: open.file.starter,
      codeVersion: o.codeVersion + 1,
    }))
    $.ui.toast('Back to a blank starter. Your previous attempt is kept in .leet/attempts/.')
  })

const toggleInterview = async ($: $) => {
  const open = await read($, openAtom)
  if (!open) return
  const timer = (await read($, progressAtom)).problems[open.slug]?.timer
  const next =
    timer && !timer.isTimeUp
      ? undefined
      : { startedAt: await $.clock.now(), limitMs: INTERVIEW_MINUTES[open.file.entry.difficulty] * 60_000 }
  await saveProgress($, p => recordTimer(p, open.slug, next))
  if (next) await update($, tickAtom, () => next.startedAt)
  await startTicker($)
}

const openInEditor = async ($: $, surface: Parameters<$['ui']['copy']>[0]['surface']) => {
  const open = await read($, openAtom)
  if (!open) return
  await flushDraft($)
  const path = `${open.dir}/solution.ts`
  // On Windows `code` is a .cmd script, which only a shell can start.
  const argv = platform.isWindows ? ['cmd.exe', '/c', 'code', path] : ['code', path]
  const ran = await $.process.run(argv).catch(() => undefined)
  if (ran?.exitCode === 0) return
  const copied = await $.ui.copy({ text: path, surface })
  $.ui.toast(`VS Code did not open (is \`code\` on your PATH?). ${copied.isCopied ? 'Copied' : 'File'}: ${path}`, { timeoutMs: 10000 })
}

const showNotebook = async ($: $, pattern: string) => {
  await setView($, { notebookPattern: pattern })
  const path = `${root}/patterns/${patternFile(pattern)}`
  const text = (await $.fs.exists(path)) ? await $.fs.read(path) : `# ${pattern}\n\nNo cards yet: solve a ${pattern} problem and answer Claude's explain-back question.`
  await update($, notebookAtom, () => text)
}

// One accent, as Anthropic's example mods use: LeetCode's amber for frames, titles and the current tab.
const ACCENT = '#ffa116'
// LeetCode's own difficulty and verdict colours.
const LEVEL_COLOR: Record<Difficulty, string> = { Easy: '#00b8a3', Medium: '#ffc01e', Hard: '#ff375f' }
const PASS = '#2cbb5d'
const FAIL = '#ef4743'
const VERDICT_GLYPH: Record<string, string> = {
  Accepted: '✓',
  'Wrong Answer': '✗',
  'Runtime Error': '⚠',
  'Compile Error': '⚠',
  'Time Limit Exceeded': '⏱',
}

const bar = (done: number, total: number, width: number) => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)

  return { filled: '━'.repeat(filled), empty: '─'.repeat(width - filled) }
}

// A Code element refuses control characters other than tab and newline; a damaged file must still show.
const printable = (code: string) => code.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '\u00b7')

const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'leet', description: 'Open the LeetCode hub: daily problem, tutor, progress' })
    platform.isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~'
    root = `${home.replaceAll('\\', '/')}/leetcode`
    const stored = (await $.store.get(STORE_KEY)) as Progress | undefined
    // The store is the record: with it cleared, the session starts over too.
    await update($, progressAtom, () => stored ?? emptyProgress())
    const hidden = (await $.store.get(BAND_KEY)) as string | undefined
    await update($, bandAtom, () => hidden ?? '')
    await update($, todayAtom, () => '')
    await refreshDay($).catch(error => $.ui.log(`leet: could not read today's date: ${errorText(error)}`, { to: 'debug' }))
    $.clock.every(5 * 60_000, () => void refreshDay($).catch(() => undefined))
    // Session state outlives a reload of this module, so bring it up to what this version expects.
    await update($, busyAtom, () => null)
    // A fault belongs to the module that had it; a reload brings a new one, so try the editor again.
    await update($, faultsAtom, () => ({}))
    await update($, viewAtom, v => ({ ...DEFAULT_VIEW, ...v }))
    const open = await read($, openAtom)
    const isOpenGone = open !== null && !(await $.fs.exists(`${open.dir}/.leet/problem.json`))
    if (isOpenGone) {
      await update($, openAtom, () => null)
      await update($, viewAtom, () => DEFAULT_VIEW)
    } else if (open && typeof open.code !== 'string') {
      await loadOpen($, open.slug).catch(() => update($, openAtom, () => null))
    } else if (open) {
      known.set(open.slug, open.code)
      await startTicker($)
      watchFile($)
    }

    return next(e)
  })

  on('command.run', { command: 'leet' }, async $ => {
    const opened = await openHub($)

    return { text: opened.isPlaced ? 'LeetCode hub opened.' : `LeetCode hub is waiting for room: ${opened.reason}` }
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as { slug?: unknown; version?: unknown; text?: unknown; action?: unknown; clip?: unknown } | null
    if (!e.module.endsWith('editor.tsx') || typeof data?.text !== 'string') return next(e)
    if (typeof data.clip === 'string') {
      const copied = await $.ui.copy({ text: data.clip, surface: e.surface })
      if (!copied.isCopied) $.ui.toast('Copied for this editor only (no clipboard access here): Alt+V or Paste puts it back.')
    }
    const open = await read($, openAtom)
    // A post from a buffer the hub has since replaced must not overwrite the file.
    if (!open || data.slug !== open.slug || data.version !== open.codeVersion) return {}
    saveDraft($, open, data.text)
    // A problem counts as started at its first edit, so browsing with Previous and Next marks nothing.
    if (data.text !== known.get(open.slug) && (await read($, progressAtom)).problems[open.slug] === undefined) {
      await saveProgress($, p => recordOpened(p, open.slug))
    }
    if (data.action === 'run') void runCode($, 'run')

    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, hubAtom, () => false)

    return next(e)
  })



  on('ui.fault', async ($, e, next) => {
    if (e.module.endsWith('editor.tsx')) {
      await update($, faultsAtom, f => ({ ...f, [e.surface]: `${e.phase}: ${e.reason}` }))
      $.ui.toast(`The code editor failed on ${e.surface} (${e.reason}). Edit in VS Code; the hub shows your saves.`, { timeoutMs: 10000 })
      if (root) {
        const line = `${new Date(await $.clock.now()).toISOString()} ${e.surface} ${e.phase} ${e.reason}\n`
        const path = `${root}/.leet-editor-faults.log`
        const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
        await $.fs.write(path, (before + line).slice(-20_000)).catch(() => undefined)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const progress = await read($, progressAtom)
    const day = await read($, todayAtom)
    const daily = progress.daily
    const isQuiet =
      e.props.hasSurvey ||
      !daily ||
      daily.day !== day ||
      daily.isDone ||
      (await read($, bandAtom)) === day ||
      (await read($, hubAtom))
    const entry = daily && BY_SLUG[daily.slug]
    if (isQuiet || !entry) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const streak = shownStreak(progress, day)
    const isReview = progress.problems[entry.slug]?.review !== undefined

    return (
      <Box flexDirection="row" gap={2} paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold color={ACCENT}>◆ {isReview ? 'Review' : 'Daily'}</Text>
          <Text>  </Text>
          <Text bold>{entry.title}</Text>
          <Text>  </Text>
          <Text color={LEVEL_COLOR[entry.difficulty]}>{entry.difficulty}</Text>
          <Text dimColor> · {entry.pattern}</Text>
          {streak > 0 && <Text dimColor>   streak <Text bold color={ACCENT}>{streak}</Text></Text>}
        </Text>
        <Button
          key="band-open"
          label="Open"
          hotkey="o"
          plain
          onPress={async () => {
            await openHub($)
            await openProblem($, entry.slug)
          }}
        />
        <Button
          key="band-later"
          label="Later"
          hotkey="l"
          plain
          dimColor
          onPress={async () => {
            await update($, bandAtom, () => day)
            await $.store.set(BAND_KEY, day)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    // The mobile app draws no text field yet, and the hub needs one for the tutor.
    if (!('Input' in ui)) return <ui.Text>Open the LeetCode hub in the terminal or the desktop app.</ui.Text>
    const { Box, Button, Code, Input, Markdown, Text } = ui
    const faults = await read($, faultsAtom)
    // The custom editor needs the surface to hand it keys. The terminal does; the desktop app gives a
    // Client no keyboard focus yet, so there a native text box is the default.
    const Client = 'Client' in ui && faults[e.surface] === undefined ? ui.Client : undefined
    const progress = await read($, progressAtom)
    const day = await read($, todayAtom)
    const view = await read($, viewAtom)
    const open = await read($, openAtom)
    const working = await read($, busyAtom)
    const isDock = e.props.placement === 'dock'
    const padX = e.props.bodyColumns >= 60 ? 2 : 1
    // Everything below lays out in the frame's inner width, inside the padding.
    const width = Math.max(26, e.props.bodyColumns - padX * 2)
    const counts = solvedCounts(progress)
    const solved = counts.Easy + counts.Medium + counts.Hard
    const streak = shownStreak(progress, day)
    const rec = open ? progress.problems[open.slug] : undefined
    const tickNow = rec?.timer && !rec.timer.isTimeUp ? Math.max(await read($, tickAtom), rec.timer.startedAt) : 0
    const editorRows = Math.max(10, Math.min(24, e.props.scroll.bodyRows - 8))
    const go = (tab: Tab) => () => setView($, { tab })

    const TABS: [Tab, string, string][] = [
      ['home', 'Home', 'h'],
      ['problem', 'Problem', 'p'],
      ['tutor', 'Tutor', 't'],
      ['history', 'Submissions', 's'],
      ['list', 'List', 'l'],
      ['notebook', 'Notebook', 'n'],
    ]

    // The shared page kit: every tab is a heading row, then sections under a ruled label.
    const rule = (left: string, right = '') => {
      const room = width - left.length - (left ? 1 : 0)
      const tail = right && room - right.length - 3 >= 4 ? right : ''
      const fill = Math.max(2, room - (tail ? tail.length + 3 : 0))

      return { tail, fill: '─'.repeat(fill) }
    }
    const section = (title: string, hint = '') => {
      const r = rule(title, hint)

      return (
        <Text wrap="truncate-end">
          <Text bold dimColor>{title}</Text>
          <Text dimColor> {r.fill}</Text>
          {r.tail && <Text dimColor italic> {r.tail} ─</Text>}
        </Text>
      )
    }
    const pageHead = (title: string, right?: RenderElement) => (
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Text bold color={ACCENT} wrap="truncate-end">◆ {title}</Text>
        {right}
      </Box>
    )
    const empty = (title: string, text: string) => (
      <Box flexDirection="column" gap={1}>
        {pageHead(title)}
        <Text dimColor italic>{text}</Text>
      </Box>
    )
    const field = (label: string) => <Text dimColor>{label.padEnd(10, ' ')}</Text>
    // The terminal's Select only takes keys once it holds the focus, so a click left its list open
    // and stuck; every pick is a press instead. The label's hotkey steps to the next option.
    type Option = { value: string; label: string }
    const stepOf = (options: Option[], value: string, by: number) => {
      const at = Math.max(0, options.findIndex(o => o.value === value))
      return options[(at + by + options.length) % options.length] ?? options[0]!
    }
    const chips = (key: string, label: string, hotkey: string, options: Option[], value: string, pick: (value: string) => unknown) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key={`${key}-step`} plain hotkey={hotkey} onPress={() => pick(stepOf(options, value, 1).value)}>
          <Text dimColor>{label.padEnd(7, ' ')}</Text>
        </Button>
        {options.map(o => (
          <Button key={`${key}-${o.value}`} plain onPress={() => pick(o.value)}>
            {o.value === value ? <Text inverse bold color={ACCENT}> {o.label} </Text> : <Text dimColor> {o.label} </Text>}
          </Button>
        ))}
      </Box>
    )
    const stepper = (key: string, label: string, hotkey: string, options: Option[], value: string, pick: (value: string) => unknown) => (
      <Box flexDirection="row" columnGap={1}>
        <Button key={`${key}-step`} plain hotkey={hotkey} onPress={() => pick(stepOf(options, value, 1).value)}>
          <Text dimColor>{label.padEnd(7, ' ')}</Text>
        </Button>
        <Button key={`${key}-prev`} plain onPress={() => pick(stepOf(options, value, -1).value)}><Text color={ACCENT}> ‹ </Text></Button>
        <Text bold wrap="truncate-end">{stepOf(options, value, 0).label}</Text>
        <Button key={`${key}-next`} plain onPress={() => pick(stepOf(options, value, 1).value)}><Text color={ACCENT}> › </Text></Button>
      </Box>
    )
    const LEVEL_OPTIONS = DIFFICULTIES.map(d => ({ value: d, label: d }))

    const busyRule = rule('', working === null ? '' : `◌ ${working}`)
    const header = (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
          <Text bold color={ACCENT}>◆ LeetCode</Text>
          <Text>
            <Text dimColor>streak </Text><Text bold color={streak > 0 ? ACCENT : undefined}>{streak}</Text>
            <Text dimColor>   solved </Text><Text bold>{solved}</Text><Text dimColor>/{CATALOG.length}</Text>
            <Text dimColor>   </Text>
            <Text color={LEVEL_COLOR.Easy}>E {counts.Easy}</Text><Text dimColor>  </Text>
            <Text color={LEVEL_COLOR.Medium}>M {counts.Medium}</Text><Text dimColor>  </Text>
            <Text color={LEVEL_COLOR.Hard}>H {counts.Hard}</Text>
          </Text>
        </Box>
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {TABS.map(([tab, label, hotkey]) => (
              <Button key={`tab-${tab}`} hotkey={hotkey} plain onPress={go(tab)}>
                {view.tab === tab ? <Text inverse bold color={ACCENT}> {label} </Text> : <Text dimColor>{label}</Text>}
              </Button>
            ))}
          </Box>
          {/* Work in progress rides on the rule, so the page below never shifts. */}
          <Text wrap="truncate-end">
            <Text dimColor>{busyRule.fill}</Text>
            {busyRule.tail && <Text italic color={ACCENT}> {busyRule.tail} </Text>}
            {busyRule.tail && <Text dimColor>─</Text>}
          </Text>
        </Box>
      </Box>
    )

    const shortRoot = root.replace(/^\/(home|Users)\/[^/]+/, '~').replace(/^[A-Za-z]:\/Users\/[^/]+/, '~')
    const footer = (
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        {width >= 56 && <Text dimColor>files in {shortRoot}</Text>}
        <Text dimColor>Tab moves · Enter presses · ↑↓ scrolls</Text>
      </Box>
    )

    const problemRow = (slug: string, prefix: string, isLocked = false) => {
      const entry = BY_SLUG[slug]
      if (!entry) return null
      const r = progress.problems[slug]
      const mark = isLocked ? '·' : r?.status === 'solved' ? '✓' : r ? '○' : ' '
      const markColor = r?.status === 'solved' ? PASS : r ? ACCENT : undefined
      const titleWidth = Math.max(10, width - 20)

      return (
        <Button key={`${prefix}-${slug}`} plain dimColor={isLocked} onPress={() => openProblem($, slug)}>
          <Text color={markColor}>{mark} </Text>
          <Text dimColor>{String(entry.id).padStart(4, ' ')}  </Text>
          {clip(entry.title, titleWidth).padEnd(titleWidth, ' ')}
          <Text color={LEVEL_COLOR[entry.difficulty]}> {entry.difficulty[0]}</Text>
        </Button>
      )
    }

    const home = () => {
      const daily = progress.daily?.day === day ? progress.daily : null
      const entry = daily && BY_SLUG[daily.slug]
      const reviews = dueReviews(progress, day).filter(r => r.slug !== daily?.slug)
      const stats = patternStats(progress)
      const nameWidth = 18
      const barWidth = Math.max(6, Math.min(20, width - nameWidth - 22))
      const isStarted = entry ? progress.problems[entry.slug] !== undefined : false
      const isReview = entry ? progress.problems[entry.slug]?.review !== undefined : false

      return (
        <Box flexDirection="column" gap={1}>
          {pageHead('Home', <Text dimColor>{day}</Text>)}

          <Box flexDirection="column" gap={1} borderStyle="round" borderColor={ACCENT} paddingX={2}>
            <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
              <Text bold color={ACCENT}>{isReview ? '↻ Review due today' : '◆ Today’s problem'}</Text>
              {entry && <Text bold color={LEVEL_COLOR[entry.difficulty]}>{entry.difficulty}</Text>}
            </Box>
            {entry && daily ? (
              <Box flexDirection="column">
                <Text bold wrap="truncate-end">{entry.title}</Text>
                <Text wrap="truncate-end"><Text dimColor>#{entry.id}  ·  </Text>{entry.pattern}</Text>
                {isReview && <Text dimColor italic>Solve it again from a blank file to lock the pattern in.</Text>}
              </Box>
            ) : (
              <Text dimColor italic>{solved < CATALOG.length ? 'Picking today’s problem…' : 'Every problem on the roadmap is solved.'}</Text>
            )}
            {entry && daily && (
              <Box flexDirection="row" columnGap={3} flexWrap="wrap">
                {daily.isDone ? (
                  <Text color={PASS}>✓ Done for today</Text>
                ) : (
                  <Button plain key="daily-start" label={isStarted ? 'Continue' : 'Start'} hotkey="d" variant="primary" onPress={() => openProblem($, entry.slug)} />
                )}
                <Text dimColor italic>{daily.isDone ? 'Keep going below if you have time' : 'One a day keeps the streak'}</Text>
              </Box>
            )}
          </Box>

          <Box flexDirection="column" gap={1}>
            {section('PRACTICE MORE')}
            {chips('next-level', 'Level', 'v', [{ value: 'roadmap', label: 'Roadmap' }, ...LEVEL_OPTIONS], view.nextLevel, value => setView($, { nextLevel: value }))}
            <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
              <Button
                plain
                key="next-problem"
                label="Next problem"
                hotkey="x"
                onPress={async () => {
                  const level = view.nextLevel === 'roadmap' ? undefined : (view.nextLevel as Difficulty)
                  const exclude = [progress.daily?.slug ?? '', open?.slug ?? '']
                  const slug = pickNext(await read($, progressAtom), day, { exclude, level })
                  if (slug) await openProblem($, slug)
                  else $.ui.toast('Nothing left at that level.')
                }}
              />
              <Text dimColor italic>{view.nextLevel === 'roadmap' ? 'the next step on your roadmap' : `any ${view.nextLevel} problem, roadmap or not`}</Text>
            </Box>
          </Box>

          {reviews.length > 0 && (
            <Box flexDirection="column" gap={1}>
              {section('REVIEWS DUE', `${reviews.length}`)}
              <Box flexDirection="column">{reviews.map(r => problemRow(r.slug, 'review'))}</Box>
            </Box>
          )}

          <Box flexDirection="column" gap={1}>
            {section('ROADMAP', `${stats.filter(s => s.isUnlocked).length} of ${stats.length} open`)}
            <Box flexDirection="column">
              {stats.map(stat => {
                const b = bar(stat.solved, stat.total, barWidth)
                const levels = unlockedLevels(progress, stat.pattern)

                return (
                  <Text key={`road-${stat.pattern}`} wrap="truncate-end" dimColor={!stat.isUnlocked}>
                    <Text color={stat.isDone ? PASS : stat.isUnlocked ? ACCENT : undefined}>{stat.isDone ? '✓' : stat.isUnlocked ? '▸' : '·'}  </Text>
                    {clip(stat.pattern, nameWidth).padEnd(nameWidth + 2, ' ')}
                    <Text color={stat.isUnlocked ? ACCENT : undefined}>{b.filled}</Text>
                    <Text dimColor>{b.empty}</Text>
                    <Text dimColor>{`${stat.solved}/${stat.total}`.padStart(7, ' ')}   </Text>
                    {stat.isUnlocked
                      ? DIFFICULTIES.map(level => (
                          <Text key={level} color={levels.includes(level) ? LEVEL_COLOR[level] : undefined} dimColor={!levels.includes(level)}>{level[0]} </Text>
                        ))
                      : ''}
                  </Text>
                )
              })}
            </Box>
            <Text dimColor italic>E M H light up as each level unlocks: 3 clean solves move you up.</Text>
          </Box>
        </Box>
      )
    }

    const reportView = (report: RunReport) => {
      const isOk = report.verdict === 'Accepted'
      const tone = isOk ? PASS : FAIL
      const f = report.failing
      const failIndex = f ? f.index : -1
      const dots = Array.from({ length: report.total }, (_, i) => {
        const c = report.cases.find(x => x.index === i)
        return c ? (c.isPass && i !== failIndex ? 'pass' : 'fail') : i < Math.max(0, failIndex) ? 'pass' : i === failIndex ? 'fail' : 'skip'
      })

      return (
        <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={2}>
          <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
            <Text bold color={tone}>
              {VERDICT_GLYPH[report.verdict] ?? '•'} {report.kind === 'run' && isOk ? 'Examples pass' : report.verdict}
            </Text>
            <Text dimColor>{report.passed}/{report.total} {report.kind === 'run' ? 'examples' : 'tests'} · {report.ms} ms</Text>
          </Box>
          <Text wrap="truncate-end">
            {dots.map((d, i) => (
              <Text key={`dot${i}`} color={d === 'pass' ? PASS : d === 'fail' ? FAIL : undefined} dimColor={d === 'skip'}>{d === 'skip' ? '○' : '●'}</Text>
            ))}
          </Text>
          {report.compileError && <Code source={report.compileError} language="text" wrap="truncate-end" />}
          {f && (
            <Box flexDirection="column" marginTop={1}>
              <Text wrap="truncate-end">{field('Case')}{String(f.index + 1)}</Text>
              <Text wrap="truncate-end">{field('Input')}{f.input}</Text>
              {f.expected !== undefined && <Text wrap="truncate-end">{field('Expected')}{f.expected}</Text>}
              {f.got !== undefined && <Text wrap="truncate-end">{field('Output')}<Text bold color={FAIL}>{f.got}</Text></Text>}
              {f.error && <Code source={f.error} language="text" />}
              {report.verdict === 'Time Limit Exceeded' && f.isPass && <Text dimColor italic>Correct, but far slower than the expected complexity.</Text>}
            </Box>
          )}
          {report.kind === 'run' && !f && (
            <Box flexDirection="column" marginTop={1}>
              {report.cases.map(c => (
                <Text key={`case-${c.index}`} wrap="truncate-end"><Text color={PASS}>✓ </Text><Text dimColor>{c.input} → </Text>{c.got}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const CONSOLE_LINES = 60
    const logBlock = (text: string) => {
      const lines = text.split('\n')
      const more = lines.length - CONSOLE_LINES

      return (
        <Box flexDirection="column">
          <Code source={printable(lines.slice(0, CONSOLE_LINES).join('\n'))} language="text" />
          {more > 0 && <Text dimColor italic>… {more} more lines</Text>}
        </Box>
      )
    }
    // What console.log printed, case by case, as LeetCode's Stdout panel shows it.
    const consoleView = (report: RunReport) => {
      if (report.compileError !== undefined && report.verdict === 'Compile Error') return null
      const failing = report.failing
      // A failed submit is about the case that failed; hidden tests that passed have nothing to tell.
      const pool = report.kind === 'submit' && failing ? [failing] : [...report.cases]
      if (failing && !pool.some(c => c.index === failing.index)) pool.push(failing)
      const printed = pool.filter(c => c.logs !== undefined).slice(0, 12)
      const picked = printed.find(c => c.index === view.consoleCase) ?? printed[0]
      const lineCount = [report.loadLogs, ...printed.map(c => c.logs)].reduce((sum, t) => sum + (t ? t.split('\n').length : 0), 0)
      const isSilent = printed.length === 0 && report.loadLogs === undefined

      return (
        <Box flexDirection="column" gap={1}>
          {section('CONSOLE', isSilent ? 'nothing logged' : `${lineCount} line${lineCount === 1 ? '' : 's'}`)}
          {isSilent && <Text dimColor italic>console.log output from each case shows here.</Text>}
          {report.loadLogs !== undefined && (
            <Box flexDirection="column">
              <Text dimColor>While the file loaded</Text>
              {logBlock(report.loadLogs)}
            </Box>
          )}
          {printed.length > 1 &&
            chips(
              'console-case',
              'Case',
              'c',
              printed.map(c => ({ value: String(c.index), label: `${c.index + 1}` })),
              String(picked?.index ?? ''),
              value => setView($, { consoleCase: Number(value) }),
            )}
          {picked && (
            <Box flexDirection="column">
              <Text wrap="truncate-end">{field(`Case ${picked.index + 1}`)}<Text dimColor>{picked.input}</Text></Text>
              {logBlock(picked.logs ?? '')}
            </Box>
          )}
        </Box>
      )
    }

    const problem = () => {
      if (!open) return empty('Problem', 'No problem open yet. Start today’s problem on Home (h).')
      const entry = open.file.entry
      const timer = rec?.timer
      const left = timer ? Math.max(0, timer.limitMs - (tickNow - timer.startedAt)) : 0
      const isInterview = timer !== undefined && !timer.isTimeUp
      const clock = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
      const isReviewDue = rec?.status === 'solved' && rec.review !== undefined && rec.review.due <= day
      const isFailing = open.report !== null && open.report.verdict !== 'Accepted'
      const status = rec?.status === 'solved' ? 'Solved' : rec?.isGivenUp ? 'Gave up' : rec ? 'In progress' : 'Not started'
      const fault = faults[e.surface]
      // Where the custom editor cannot take the keyboard (no Client, a fault, or the desktop app unless
      // the person asks to try it) the hub shows the code live and editing happens in VS Code.
      const isPreview = !Client || (e.surface !== 'terminal' && !view.isCustomEditorForced)
      // An edit not yet flushed to disk is newer than the hub's copy.
      const code = draft && draft.slug === open.slug && draft.version === open.codeVersion ? draft.text : open.code
      // Previous and Next walk this pattern in roadmap order, wrapping at the ends.
      const siblings = CATALOG.filter(c => c.pattern === entry.pattern)
      const at = siblings.findIndex(c => c.slug === entry.slug)
      const prev = siblings.length > 1 ? siblings[(at - 1 + siblings.length) % siblings.length] : undefined
      const nextEntry = siblings.length > 1 ? siblings[(at + 1) % siblings.length] : undefined
      const navWidth = Math.max(8, Math.floor((width - 22) / 2) - 6)
      const navLabel = (c: CatalogEntry) => `${progress.problems[c.slug]?.status === 'solved' ? '✓ ' : ''}${clip(c.title, navWidth)}`

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {pageHead(entry.title, <Text bold color={LEVEL_COLOR[entry.difficulty]}>{entry.difficulty}</Text>)}
            <Text wrap="truncate-end">{field('Pattern')}{entry.pattern}<Text dimColor>  #{entry.id}</Text></Text>
            <Text wrap="truncate-end">{field('Status')}<Text color={rec?.status === 'solved' ? PASS : undefined}>{status}</Text></Text>
            {isInterview && <Text wrap="truncate-end">{field('Timer')}<Text bold color={ACCENT}>⏱ {clock}</Text><Text dimColor>  interview mode, tutor off</Text></Text>}
          </Box>

          {prev && nextEntry && (
            <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
              <Button key="nav-prev" plain hotkey="k" onPress={() => openProblem($, prev.slug)}>
                <Text color={ACCENT}>‹ </Text><Text dimColor>{navLabel(prev)}</Text>
              </Button>
              <Text dimColor>{at + 1} of {siblings.length}</Text>
              <Button key="nav-next" plain hotkey="j" onPress={() => openProblem($, nextEntry.slug)}>
                <Text dimColor>{navLabel(nextEntry)}</Text><Text color={ACCENT}> ›</Text>
              </Button>
            </Box>
          )}

          {isReviewDue && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={3} borderStyle="round" borderColor={ACCENT} paddingX={2}>
              <Text color={ACCENT}>↻ Review due: solve it again from scratch.</Text>
              <Button plain key="review-start" label="Start fresh" hotkey="f" onPress={() => restartReview($)} />
            </Box>
          )}

          <Box flexDirection="column" gap={1}>
            <Button key="statement-toggle" plain onPress={() => setView($, { isStatementHidden: !view.isStatementHidden })}>
              {section(view.isStatementHidden ? '▸ DESCRIPTION' : '▾ DESCRIPTION', view.isStatementHidden ? 'show' : 'hide')}
            </Button>
            {!view.isStatementHidden && <Markdown text={statementMarkdown(open.file)} />}
          </Box>

          <Box flexDirection="column" gap={1}>
            {section('SOLUTION.TS', isPreview ? 'live view · edit with o' : 'click to type · Alt+R runs · Esc leaves')}
            <Box borderStyle="round" borderColor={ACCENT} borderDimColor paddingX={1}>
              {isPreview ? (
                <Code source={printable(code)} language="typescript" startLine={1} />
              ) : Client ? (
                <Client
                  key={`editor-${open.slug}`}
                  module="./editor.tsx"
                  props={{ slug: open.slug, text: code, version: open.codeVersion, rows: editorRows, columns: width - 4 }}
                  height={editorRows}
                  flexGrow={1}
                />
              ) : (
                <Code source={printable(code)} language="typescript" startLine={1} />
              )}
            </Box>
            {isPreview && (
              <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
                <Button plain key="edit-vscode" label="Edit in VS Code" hotkey="o" variant="primary" onPress={() => void openInEditor($, e.surface)} />
                <Text dimColor>Saves show up here within 2 s; Run and Submit use the saved file</Text>
              </Box>
            )}
            {fault && <Text dimColor italic>The code editor failed here ({fault}).</Text>}
            {e.surface !== 'terminal' && Client && (
              <Button key="editor-mode" plain dimColor onPress={() => setView($, { isCustomEditorForced: !view.isCustomEditorForced })}>
                {view.isCustomEditorForced ? 'Back to the live view' : 'Try the in-pane editor (this app may not send it your typing yet)'}
              </Button>
            )}
          </Box>

          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button plain key="act-run" label="Run" hotkey="r" onPress={() => runCode($, 'run')} />
            <Button plain key="act-submit" label="Submit" hotkey="u" variant="primary" onPress={() => runCode($, 'submit')} />
            {!isInterview && <Button plain key="act-hint" label="Hint" hotkey="i" onPress={() => sendToTutor($, 'Give me a hint for my next step.', true)} />}
            {rec?.isEditorialUnlocked ? (
              <Button plain key="act-editorial" label="Editorial" hotkey="e" onPress={() => showEditorial($)} />
            ) : (
              <Button plain key="act-giveup" label="Give up" hotkey="g" dimColor onPress={() => setView($, { isConfirmingGiveUp: true })} />
            )}
            {rec?.status !== 'solved' && (
              <Button plain key="act-interview" label={isInterview ? 'Stop timer' : `Interview ${INTERVIEW_MINUTES[entry.difficulty]}m`} hotkey="m" dimColor onPress={() => toggleInterview($)} />
            )}
            {!isPreview && <Button plain key="act-vscode" label="VS Code" hotkey="o" dimColor onPress={() => void openInEditor($, e.surface)} />}
          </Box>

          {view.isConfirmingGiveUp && !rec?.isEditorialUnlocked && (
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={FAIL} paddingX={2}>
              <Box flexDirection="column">
                <Text bold color={FAIL}>Give up on this one?</Text>
                <Text dimColor>The editorial unlocks, and the problem comes back for review in 3 days.</Text>
              </Box>
              <Box flexDirection="row" columnGap={3}>
                <Button plain key="giveup-no" label="Keep trying" hotkey="1" onPress={() => setView($, { isConfirmingGiveUp: false })} />
                <Button plain key="giveup-yes" label="Show me" hotkey="2" dimColor onPress={() => giveUp($)} />
              </Box>
            </Box>
          )}

          {open.report && reportView(open.report)}
          {open.report && consoleView(open.report)}
          {isFailing && !isInterview && (
            <Button plain key="act-why" label="Ask the tutor why it fails" hotkey="w" onPress={() => sendToTutor($, 'My last attempt fails on the case shown. Help me find out why, without giving me the fix.')} />
          )}

          {open.question !== null && (
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={ACCENT} paddingX={2}>
              <Text bold color={ACCENT}>◆ Explain it back</Text>
              <Text>{open.question}</Text>
              <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
                <Button plain key="act-answer" label="Answer in Tutor" hotkey="a" onPress={go('tutor')} />
                <Text dimColor>Saying it in your own words is what makes the pattern stick</Text>
              </Box>
            </Box>
          )}

          {open.review !== null && (
            <Box flexDirection="column" gap={1}>
              {section('CLAUDE’S REVIEW')}
              <Markdown text={open.review} />
            </Box>
          )}
          {open.editorial !== null && (
            <Box flexDirection="column" gap={1}>
              {section('EDITORIAL')}
              <Markdown text={open.editorial} />
            </Box>
          )}
        </Box>
      )
    }

    const tutor = () => {
      if (!open) return empty('Tutor', 'Open a problem first: the tutor coaches you on it.')
      const timer = rec?.timer
      if (timer && !timer.isTimeUp) {
        return empty('Tutor', '⏱ Interview mode: the tutor is off until the timer ends or you stop it on the Problem tab.')
      }
      const isAnswering = open.question !== null

      return (
        <Box flexDirection="column" gap={1}>
          {pageHead('Tutor', <Text dimColor wrap="truncate-end">{open.file.entry.title}</Text>)}
          {open.chat.length === 0 && (
            <Text dimColor italic>Ask how to start, why a case fails, or what complexity to aim for. It sees your current code and last run, and nudges rather than tells.</Text>
          )}
          {open.chat.slice(-30).map((m, i) =>
            m.role === 'you' ? (
              <Box key={`msg-${i}`} flexDirection="row" columnGap={2}>
                <Text bold color={ACCENT}>you</Text>
                <Text wrap="wrap">{m.text}</Text>
              </Box>
            ) : (
              <Box key={`msg-${i}`} flexDirection="column">
                <Text bold dimColor>tutor</Text>
                <Markdown text={m.text} />
              </Box>
            ),
          )}
          <Input
            key={`ask-${open.chat.length}-${open.chatClearedAt ?? 0}`}
            label={isAnswering ? 'Your answer' : 'Ask'}
            placeholder={isAnswering ? 'Explain the pattern in your own words…' : 'How should I think about this?'}
            rows={3}
            submitLabel="send"
            autoFocus
            onSubmit={value => sendToTutor($, value)}
          />
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            {isAnswering && <Button plain key="skip-explain" label="Skip, just save the card" hotkey="k" dimColor onPress={() => sendToTutor($, '(skipped)')} />}
            {open.chat.length > (isAnswering ? 1 : 0) && <Button plain key="tutor-clear" label="Clear chat" dimColor onPress={() => clearChat($)} />}
            <Text dimColor italic>type /clear to start the tutor over</Text>
          </Box>
        </Box>
      )
    }

    const history = () => {
      if (!open) return empty('Submissions', 'Open a problem to see its submissions.')
      const list = open.submissions.map((s, i) => ({ s, i })).reverse()
      const picked = view.submissionIndex === null ? undefined : open.submissions[view.submissionIndex]
      const time = (at: number) => new Date(at).toISOString().slice(5, 16).replace('T', ' ')

      return (
        <Box flexDirection="column" gap={1}>
          {pageHead('Submissions', <Text dimColor wrap="truncate-end">{open.file.entry.title}</Text>)}
          {list.length === 0 && <Text dimColor italic>No runs yet. Run or Submit from the Problem tab.</Text>}
          <Box flexDirection="column">
            {list.map(({ s, i }) => {
              const isOk = s.verdict === 'Accepted'

              return (
                <Button key={`sub-${i}`} plain onPress={() => setView($, { submissionIndex: i })}>
                  <Text color={isOk ? PASS : FAIL}>{(VERDICT_GLYPH[s.verdict] ?? '•') + ' ' + s.verdict.padEnd(20, ' ')}</Text>
                  <Text dimColor>{s.kind.padEnd(7, ' ')}{`${s.passed}/${s.total}`.padStart(6, ' ')}{`${s.ms} ms`.padStart(9, ' ')}  {time(s.at)}</Text>
                </Button>
              )
            })}
          </Box>
          {picked && (
            <Box flexDirection="column" gap={1}>
              {reportView(picked)}
              {consoleView(picked)}
              <Code source={printable(picked.code)} language="typescript" startLine={1} />
            </Box>
          )}
        </Box>
      )
    }

    const list = () => {
      const patterns = unlockedPatterns(progress)
      const statusOf = (entry: CatalogEntry) => {
        const r = progress.problems[entry.slug]
        if (r?.review && r.review.due <= day) return 'review'
        return r?.status ?? 'todo'
      }
      const rows = CATALOG.filter(
        entry =>
          (view.listDifficulty === 'all' || entry.difficulty === view.listDifficulty) &&
          (view.listPattern === 'all' || entry.pattern === view.listPattern) &&
          (view.listStatus === 'all' || statusOf(entry) === view.listStatus),
      )

      return (
        <Box flexDirection="column" gap={1}>
          {pageHead('Problems', <Text dimColor>{rows.length} of {CATALOG.length}</Text>)}
          <Box flexDirection="column">
            {chips('f-level', 'Level', 'v', [{ value: 'all', label: 'All' }, ...LEVEL_OPTIONS], view.listDifficulty, value => setView($, { listDifficulty: value }))}
            {chips('f-status', 'Status', 'c', [
              { value: 'all', label: 'All' },
              { value: 'todo', label: 'Todo' },
              { value: 'attempted', label: 'Attempted' },
              { value: 'solved', label: 'Solved' },
              { value: 'review', label: 'Review due' },
            ], view.listStatus, value => setView($, { listStatus: value }))}
            {stepper('f-pattern', 'Pattern', 'b', [{ value: 'all', label: 'All patterns' }, ...PATTERNS.map(p => ({ value: p, label: p }))], view.listPattern, value => setView($, { listPattern: value }))}
          </Box>
          <Text dimColor wrap="truncate-end"><Text color={PASS}>✓</Text> solved   <Text color={ACCENT}>○</Text> started   · not on your roadmap yet</Text>
          <Box flexDirection="column">
            {rows.map(entry => {
              const isLocked = !patterns.includes(entry.pattern) || !unlockedLevels(progress, entry.pattern).includes(entry.difficulty)

              return problemRow(entry.slug, 'row', isLocked && progress.problems[entry.slug] === undefined)
            })}
          </Box>
        </Box>
      )
    }

    const notebookText = await read($, notebookAtom)
    const notebook = () => (
      <Box flexDirection="column" gap={1}>
        {pageHead('Pattern notebook')}
        {stepper('nb-pattern', 'Pattern', 'b', [{ value: '', label: 'Pick a pattern' }, ...PATTERNS.map(p => ({ value: p, label: p }))], view.notebookPattern ?? '', value =>
          value === '' ? setView($, { notebookPattern: null }) : showNotebook($, value),
        )}
        {view.notebookPattern ? (
          <Markdown text={notebookText} />
        ) : (
          <Text dimColor italic>A card is written each time you solve a problem and explain it back: how to spot the pattern, its template, and your own words.</Text>
        )}
      </Box>
    )

    const body = { home, problem, tutor, history, list, notebook }[view.tab]

    // In the dock the page fills the frame, so the footer sits on its bottom edge.
    const fill = isDock ? { minHeight: e.props.scroll.bodyRows } : {}

    return (
      <Box flexDirection="column" paddingX={padX} paddingY={1} {...fill}>
        {header}
        <Box flexDirection="column" flexGrow={1} marginTop={1} marginBottom={1}>
          {body()}
        </Box>
        {footer}
      </Box>
    )
  })
}
