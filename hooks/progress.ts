import type { Difficulty, ProblemRecord, Progress } from '../types'
import { BY_SLUG, CATALOG, DIFFICULTIES, PATTERNS } from './catalog'

const REVIEW_GAPS = [3, 7, 21]
const gap = (stage: number) => REVIEW_GAPS[stage] ?? 21
const MASTERY = 3
// More failed submits or tutor questions than this and the problem comes back for review.
const STRUGGLE_SUBMITS = 3
const STRUGGLE_ASKS = 5

export const emptyProgress = (): Progress => ({
  version: 1,
  problems: {},
  daily: null,
  streak: { count: 0, lastDay: null },
})

export const addDays = (day: string, n: number) => {
  const at = new Date(`${day}T00:00:00Z`)
  // Before the session has read the date, `day` is empty.
  if (Number.isNaN(at.getTime())) return ''
  at.setUTCDate(at.getUTCDate() + n)

  return at.toISOString().slice(0, 10)
}

export const newRecord = (slug: string): ProblemRecord => ({
  slug,
  status: 'attempted',
  failedSubmits: 0,
  tutorAsks: 0,
  isGivenUp: false,
  isEditorialUnlocked: false,
  hasExplained: false,
})

const withRecord = (
  progress: Progress,
  slug: string,
  fn: (rec: ProblemRecord) => ProblemRecord,
): Progress => ({
  ...progress,
  problems: {
    ...progress.problems,
    [slug]: fn(progress.problems[slug] ?? newRecord(slug)),
  },
})

const entriesAt = (pattern: string, level: Difficulty) =>
  CATALOG.filter(e => e.pattern === pattern && e.difficulty === level)

export const startLevel = (pattern: string): Difficulty =>
  DIFFICULTIES.find(level => entriesAt(pattern, level).length > 0) ?? 'Easy'

export const cleanCount = (progress: Progress, pattern: string, level: Difficulty) =>
  entriesAt(pattern, level).filter(e => progress.problems[e.slug]?.isClean === true).length

export const isMastered = (progress: Progress, pattern: string, level: Difficulty) => {
  const total = entriesAt(pattern, level).length

  return total > 0 && cleanCount(progress, pattern, level) >= Math.min(MASTERY, total)
}

export const unlockedLevels = (progress: Progress, pattern: string): Difficulty[] => {
  const levels: Difficulty[] = []
  for (const level of DIFFICULTIES.slice(DIFFICULTIES.indexOf(startLevel(pattern)))) {
    if (entriesAt(pattern, level).length === 0) continue
    levels.push(level)
    if (!isMastered(progress, pattern, level)) break
  }

  return levels
}

export const unlockedPatterns = (progress: Progress): string[] => {
  const open: string[] = []
  for (const pattern of PATTERNS) {
    open.push(pattern)
    if (!isMastered(progress, pattern, startLevel(pattern))) break
  }

  return open
}

export const dueReviews = (progress: Progress, today: string) =>
  Object.values(progress.problems)
    .filter(rec => rec.review !== undefined && rec.review.due <= today)
    .sort((a, b) => (a.review!.due < b.review!.due ? -1 : 1))

const isOpenWork = (rec: ProblemRecord | undefined) =>
  rec === undefined || (rec.status !== 'solved' && !rec.isGivenUp)

const RANK: Record<Difficulty, number> = { Easy: 0, Medium: 1, Hard: 2 }

// Lowest difficulty first across every unlocked pattern, roadmap order breaking ties,
// so the easy problems of the whole roadmap come before its mediums.
export const pickNext = (
  progress: Progress,
  today: string,
  options: { exclude?: string[]; level?: Difficulty } = {},
): string | null => {
  const exclude = new Set(options.exclude ?? [])
  if (options.level === undefined) {
    const review = dueReviews(progress, today).find(rec => !exclude.has(rec.slug))
    if (review) return review.slug
  }

  const patterns = unlockedPatterns(progress)
  const isUnlocked = (slug: string) => {
    const entry = BY_SLUG[slug]

    return (
      entry !== undefined &&
      patterns.includes(entry.pattern) &&
      unlockedLevels(progress, entry.pattern).includes(entry.difficulty)
    )
  }
  const open = CATALOG.filter(e => !exclude.has(e.slug) && isOpenWork(progress.problems[e.slug]))
  const ordered = (list: typeof CATALOG) =>
    [...list].sort((a, b) => {
      const isStartedA = progress.problems[a.slug] !== undefined ? 0 : 1
      const isStartedB = progress.problems[b.slug] !== undefined ? 0 : 1

      return isStartedA - isStartedB || RANK[a.difficulty] - RANK[b.difficulty]
    })

  if (options.level !== undefined) {
    const atLevel = open.filter(e => e.difficulty === options.level)
    const inReach = atLevel.filter(e => patterns.includes(e.pattern))

    return (ordered(inReach)[0] ?? atLevel[0])?.slug ?? null
  }

  return (ordered(open.filter(e => isUnlocked(e.slug)))[0] ?? open[0])?.slug ?? null
}

export const ensureDaily = (progress: Progress, today: string): Progress => {
  if (progress.daily?.day === today) return progress
  const slug = pickNext(progress, today)

  return { ...progress, daily: slug === null ? null : { day: today, slug, isDone: false } }
}

export const shownStreak = (progress: Progress, today: string) => {
  const last = progress.streak.lastDay

  return last === today || last === addDays(today, -1) ? progress.streak.count : 0
}

export const isStruggle = (rec: ProblemRecord) =>
  rec.isGivenUp || rec.failedSubmits >= STRUGGLE_SUBMITS || rec.tutorAsks >= STRUGGLE_ASKS

const nextReview = (rec: ProblemRecord, today: string) => {
  if (isStruggle(rec)) return { stage: 0, due: addDays(today, gap(0)) }
  if (rec.review === undefined) return undefined
  const stage = rec.review.stage + 1

  return stage >= REVIEW_GAPS.length ? undefined : { stage, due: addDays(today, gap(stage)) }
}

export type Unlock = { pattern: string; level: Difficulty }

const unlocksOf = (progress: Progress): Unlock[] =>
  unlockedPatterns(progress).flatMap(pattern =>
    unlockedLevels(progress, pattern).map(level => ({ pattern, level })),
  )

export const recordAccepted = (
  progress: Progress,
  slug: string,
  today: string,
  now: number,
): { progress: Progress; unlocked: Unlock[]; isStreakDay: boolean } => {
  const before = unlocksOf(progress)
  let next = withRecord(progress, slug, rec => {
    const isFirst = rec.status !== 'solved'

    return {
      ...rec,
      status: 'solved',
      isClean: isFirst ? !rec.isGivenUp : rec.isClean,
      solvedAt: now,
      review: nextReview(rec, today),
      isEditorialUnlocked: true,
      timer: rec.timer && { ...rec.timer, isTimeUp: true },
    }
  })

  const daily = next.daily
  // Giving up on the daily and then solving any other problem that day still keeps the streak.
  const isDailyRescued =
    daily?.day === today &&
    !daily.isDone &&
    (daily.slug === slug || next.problems[daily.slug]?.isGivenUp === true)
  if (daily && isDailyRescued) {
    const last = next.streak.lastDay
    const count =
      last === today ? next.streak.count : last === addDays(today, -1) ? next.streak.count + 1 : 1
    next = { ...next, daily: { ...daily, isDone: true }, streak: { count, lastDay: today } }
  }

  const after = unlocksOf(next)
  const unlocked = after.filter(u => !before.some(b => b.pattern === u.pattern && b.level === u.level))

  return { progress: next, unlocked, isStreakDay: isDailyRescued }
}

export const recordGiveUp = (progress: Progress, slug: string, today: string) =>
  withRecord(progress, slug, rec => ({
    ...rec,
    isGivenUp: true,
    isEditorialUnlocked: true,
    review: { stage: 0, due: addDays(today, gap(0)) },
    timer: rec.timer && { ...rec.timer, isTimeUp: true },
  }))

export const recordFailedSubmit = (progress: Progress, slug: string) =>
  withRecord(progress, slug, rec => ({ ...rec, failedSubmits: rec.failedSubmits + 1 }))

export const recordTutorAsk = (progress: Progress, slug: string) =>
  withRecord(progress, slug, rec => ({ ...rec, tutorAsks: rec.tutorAsks + 1 }))

export const recordOpened = (progress: Progress, slug: string) => withRecord(progress, slug, rec => rec)

// Re-solving from a blank file: the counters start over, the review stage stays.
export const recordReviewStart = (progress: Progress, slug: string) =>
  withRecord(progress, slug, rec => ({
    ...rec,
    failedSubmits: 0,
    tutorAsks: 0,
    isGivenUp: false,
    hasExplained: false,
    timer: undefined,
  }))

export const recordTimer = (progress: Progress, slug: string, timer: ProblemRecord['timer']) =>
  withRecord(progress, slug, rec => ({ ...rec, timer }))

export const recordExplained = (progress: Progress, slug: string) =>
  withRecord(progress, slug, rec => ({ ...rec, hasExplained: true }))

export const solvedCounts = (progress: Progress) => {
  const counts: Record<Difficulty, number> = { Easy: 0, Medium: 0, Hard: 0 }
  for (const rec of Object.values(progress.problems)) {
    const entry = BY_SLUG[rec.slug]
    if (rec.status === 'solved' && entry) counts[entry.difficulty] += 1
  }

  return counts
}

export const patternStats = (progress: Progress) => {
  const open = unlockedPatterns(progress)

  return PATTERNS.map(pattern => {
    const entries = CATALOG.filter(e => e.pattern === pattern)
    const levels = unlockedLevels(progress, pattern)

    return {
      pattern,
      solved: entries.filter(e => progress.problems[e.slug]?.status === 'solved').length,
      total: entries.length,
      isUnlocked: open.includes(pattern),
      level: levels[levels.length - 1],
      isDone: levels.every(level => isMastered(progress, pattern, level)),
    }
  })
}
