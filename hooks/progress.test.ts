import { expect, test } from 'claude-code/testing'
import { lineDiff } from './ai'

import {
  addDays,
  dueReviews,
  emptyProgress,
  ensureDaily,
  pickNext,
  recordAccepted,
  recordFailedSubmit,
  recordGiveUp,
  recordOpened,
  shownStreak,
  unlockedLevels,
  unlockedPatterns,
} from './progress'

const DAY = '2026-10-17'

const solve = (progress: ReturnType<typeof emptyProgress>, slug: string, day = DAY) =>
  recordAccepted(recordOpened(progress, slug), slug, day, 0).progress

test('day one starts at the first easy problem of the roadmap', async () => {
  const progress = ensureDaily(emptyProgress(), DAY)
  expect(progress.daily).toEqual({ day: DAY, slug: 'contains-duplicate', isDone: false })
  expect(unlockedPatterns(progress)).toEqual(['Arrays & Hashing'])
  expect(unlockedLevels(progress, 'Arrays & Hashing')).toEqual(['Easy'])
})

test('three clean easy solves unlock medium and the next pattern, and easies come first', async () => {
  let progress = emptyProgress()
  for (const slug of ['contains-duplicate', 'valid-anagram', 'two-sum']) progress = solve(progress, slug)
  expect(unlockedLevels(progress, 'Arrays & Hashing')).toEqual(['Easy', 'Medium'])
  expect(unlockedPatterns(progress)).toEqual(['Arrays & Hashing', 'Two Pointers'])
  expect(pickNext(progress, DAY)).toBe('valid-palindrome')
})

test('a solve after giving up does not count toward mastery', async () => {
  let progress = solve(emptyProgress(), 'contains-duplicate')
  progress = solve(progress, 'valid-anagram')
  progress = recordGiveUp(recordOpened(progress, 'two-sum'), 'two-sum', DAY)
  progress = solve(progress, 'two-sum')
  expect(progress.problems['two-sum']?.isClean).toBe(false)
  expect(unlockedPatterns(progress)).toEqual(['Arrays & Hashing'])
})

test('a given-up problem comes back as the daily three days later', async () => {
  const progress = recordGiveUp(recordOpened(emptyProgress(), 'contains-duplicate'), 'contains-duplicate', DAY)
  expect(dueReviews(progress, addDays(DAY, 2))).toEqual([])
  expect(pickNext(progress, addDays(DAY, 2))).toBe('valid-anagram')
  expect(pickNext(progress, addDays(DAY, 3))).toBe('contains-duplicate')
})

test('a struggled solve is reviewed at 3, 7 and 21 days, then retired', async () => {
  let progress = recordOpened(emptyProgress(), 'valid-anagram')
  for (let i = 0; i < 3; i++) progress = recordFailedSubmit(progress, 'valid-anagram')
  progress = solve(progress, 'valid-anagram')
  expect(progress.problems['valid-anagram']?.review).toEqual({ stage: 0, due: addDays(DAY, 3) })

  const fresh = (p: typeof progress) => ({ ...p, problems: { ...p.problems, 'valid-anagram': { ...p.problems['valid-anagram']!, failedSubmits: 0 } } })
  progress = solve(fresh(progress), 'valid-anagram', addDays(DAY, 3))
  expect(progress.problems['valid-anagram']?.review).toEqual({ stage: 1, due: addDays(DAY, 10) })
  progress = solve(progress, 'valid-anagram', addDays(DAY, 10))
  expect(progress.problems['valid-anagram']?.review?.stage).toBe(2)
  progress = solve(progress, 'valid-anagram', addDays(DAY, 31))
  expect(progress.problems['valid-anagram']?.review).toBeUndefined()
})

test('solving the daily on consecutive days grows the streak; a missed day resets it', async () => {
  let progress = ensureDaily(emptyProgress(), DAY)
  progress = solve(progress, progress.daily!.slug)
  expect(shownStreak(progress, DAY)).toBe(1)

  const next = addDays(DAY, 1)
  progress = ensureDaily(progress, next)
  progress = solve(progress, progress.daily!.slug, next)
  expect(shownStreak(progress, next)).toBe(2)
  expect(shownStreak(progress, addDays(DAY, 3))).toBe(0)
})

test('giving up the daily and solving another problem that day keeps the streak', async () => {
  let progress = ensureDaily(emptyProgress(), DAY)
  progress = recordGiveUp(recordOpened(progress, 'contains-duplicate'), 'contains-duplicate', DAY)
  const result = recordAccepted(recordOpened(progress, 'valid-anagram'), 'valid-anagram', DAY, 0)
  expect(result.isStreakDay).toBe(true)
  expect(result.progress.daily?.isDone).toBe(true)
})

test('picking a level reaches past the roadmap', async () => {
  expect(pickNext(emptyProgress(), DAY, { level: 'Medium' })).toBe('group-anagrams')
  expect(pickNext(emptyProgress(), DAY, { level: 'Hard' })).toBe('trapping-rain-water')
})

test('the tutor diff shows only the lines the learner changed', async () => {
  expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toBe('- b\n+ B\n+ d')
  expect(lineDiff('same', 'same')).toBe('')
})
