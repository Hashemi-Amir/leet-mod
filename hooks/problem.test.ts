import { expect, mock, test } from 'claude-code/testing'

const DIR = '/h/leetcode/0217-contains-duplicate'
const STARTER = 'export function containsDuplicate(nums: number[]): boolean {\n\n}\n'
const PROBLEM = {
  entry: { id: 217, title: 'Contains Duplicate', slug: 'contains-duplicate', difficulty: 'Easy', pattern: 'Arrays & Hashing' },
  statement: 'Return `true` if any value appears at least twice.',
  starter: STARTER,
  spec: {
    kind: 'function',
    functionName: 'containsDuplicate',
    params: [{ name: 'nums', type: 'number[]' }],
    returns: { type: 'boolean' },
    compare: 'exact',
    constraints: ['1 <= nums.length <= 10^5'],
    examples: [{ args: [[1, 2, 3, 1]] }],
    tests: [],
    expected: [true],
    refMs: [0.1],
  },
  createdAt: 0,
}

const PANE = {
  component: 'Pane',
  requestId: 'leet',
  props: { title: 'LeetCode', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('starting today’s problem draws the statement and a working editor', async ($, on) => {
  const files: Record<string, string> = {
    [`${DIR}/.leet/problem.json`]: JSON.stringify(PROBLEM),
    [`${DIR}/solution.ts`]: STARTER,
    [`${DIR}/.leet/reference.ts`]: 'export function containsDuplicate(nums: number[]) { return new Set(nums).size < nums.length }\n',
    ['/h/leetcode/0242-valid-anagram/.leet/problem.json']: JSON.stringify({
      ...PROBLEM,
      entry: { id: 242, title: 'Valid Anagram', slug: 'valid-anagram', difficulty: 'Easy', pattern: 'Arrays & Hashing' },
    }),
    ['/h/leetcode/0242-valid-anagram/solution.ts']: STARTER,
  }
  // On Windows the engine hands these hooks backslashed, drive-lettered paths.
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 17, 9) })
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  on('fs.exists', ($, e) => ({ value: norm(e.path) in files }))
  on('fs.read', ($, e) => {
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  const RUN = {
    results: [
      { index: 0, isPass: true, input: 'nums = [1,2,3,1]', expected: 'true', got: 'true', ms: 0.1, logs: '0 1\n0 2\n0 3' },
    ],
    loadLogs: 'loaded',
  }
  on('process.run', ($, e) => {
    const isRunner = e.argv.some(a => a.endsWith('runner.mjs'))
    const stdout = isRunner ? `__LEET__${JSON.stringify(RUN)}\n` : e.argv[0] === 'git' ? '' : '2026-10-17\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }))
  const prompts: string[] = []
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: { isAnswered: true, text: 'What does your inner loop compare?', usage } } as never
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/h' }) as never)
  await $.session.start({ cwd: '/h', surface: 'terminal', isInteractive: true } as never)

  const term = await $.ui.mount({ plugin: 'leet', surface: 'terminal', ...PANE })
  await term.press({ key: 'daily-start' })
  expect(toasts).toEqual([])
  expect(await term.find({ type: 'Text', text: /Contains Duplicate/ })).toBeDefined()
  expect(await term.find({ key: 'editor-contains-duplicate' })).toBeDefined()
  await term.key({ key: 'right', in: 'editor-contains-duplicate' })

  // A run shows what console.log printed: while the file loaded, then case by case.
  await term.press({ key: 'act-run' })
  expect(await term.find({ type: 'Text', text: /CONSOLE/ })).toBeDefined()
  expect(await term.find({ type: 'Code', text: /0 1\n0 2\n0 3/ })).toBeDefined()
  expect(await term.find({ type: 'Code', text: 'loaded' })).toBeDefined()

  // Next walks the same pattern without leaving the screen; looking at a problem does not start it.
  expect(await term.find({ type: 'Text', text: /Not started/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /1 of 9/ })).toBeDefined()
  await term.press({ key: 'nav-next' })
  expect(await term.find({ type: 'Text', text: /Valid Anagram/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /2 of 9/ })).toBeDefined()
  await term.press({ key: 'nav-prev' })
  expect(await term.find({ type: 'Text', text: /◆ Contains Duplicate/ })).toBeDefined()

  // Hints coach the code on disk: numbered lines, what changed, and more concrete when pressed again.
  files[`${DIR}/solution.ts`] = 'export function containsDuplicate(nums: number[]): boolean {\n  for (let i = 0; i < nums.length; i++) {}\n}\n'
  await term.press({ key: 'act-hint' })
  expect(prompts[0]).toContain('  2    for (let i = 0; i < nums.length; i++) {}')
  expect(prompts[0]).toContain('level 1 hint')
  expect(prompts[0]).toContain('first question')
  await term.press({ key: 'tab-problem' })
  await term.press({ key: 'act-hint' })
  expect(prompts[1]).toContain('level 2 hint')
  expect(prompts[1]).toContain('has not changed')
  files[`${DIR}/solution.ts`] = 'export function containsDuplicate(nums: number[]): boolean {\n  for (let i = 0; i < nums.length; i++) {\n    for (let j = i + 1; j < nums.length; j++) {}\n  }\n}\n'
  await term.press({ key: 'tab-problem' })
  await term.press({ key: 'act-hint' })
  expect(prompts[2]).toContain('level 1 hint')
  expect(prompts[2]).toContain('+     for (let j = i + 1; j < nums.length; j++) {}')

  // Typing /clear in the Ask box empties the chat on screen and what the tutor is sent.
  await term.press({ key: 'tab-tutor' })
  expect(await term.find({ type: 'Markdown', text: /inner loop compare/ })).toBeDefined()
  const box = await term.find({ type: 'Input' })
  await term.input({ key: box!.key!, text: '/clear' })
  expect(await term.find({ type: 'Markdown', text: /inner loop compare/ })).toBeUndefined()
  expect(JSON.parse(files[`${DIR}/.leet/tutor.json`]!)).toEqual([])
  expect(prompts.length).toBe(3)
  await term.press({ key: 'tab-problem' })
  await term.press({ key: 'act-hint' })
  expect(prompts[3]).toContain('level 1 hint')
  expect(prompts[3]).toContain('first question')
  expect(prompts[3]!.split('Learner:').length - 1).toBe(1)
  await term.press({ key: 'tab-problem' })
  // Typing, then a trip to the Tutor tab and back, keeps what was typed: flushed or not.
  const editorText = async () =>
    ((await term.find({ key: 'editor-contains-duplicate' }))!.props.props as { text: string }).text
  await term.key({ key: 'end', ctrl: true, in: 'editor-contains-duplicate' })
  await term.key({ key: 'Q', in: 'editor-contains-duplicate' })
  await term.press({ key: 'tab-tutor' })
  await term.press({ key: 'tab-problem' })
  expect(await editorText()).toMatch(/Q$/)
  await term.key({ key: 'W', in: 'editor-contains-duplicate' })
  await clock.advance(1000)
  await term.press({ key: 'tab-tutor' })
  await term.press({ key: 'tab-problem' })
  expect(await editorText()).toMatch(/QW$/)
  expect(files[`${DIR}/solution.ts`]).toMatch(/QW$/)
  await term.unmount()

  // The desktop app gives the custom editor no keyboard, so it shows the file live and edits go to VS Code.
  const desk = await $.ui.mount({ plugin: 'leet', surface: 'desktop', ...PANE })
  expect(await desk.find({ key: 'editor-contains-duplicate' })).toBeUndefined()
  expect(await desk.find({ type: 'Code', text: /containsDuplicate/ })).toBeDefined()
  expect(await desk.find({ key: 'edit-vscode' })).toBeDefined()
  await desk.press({ key: 'editor-mode' })
  expect(await desk.find({ key: 'editor-contains-duplicate' })).toBeDefined()
  await desk.unmount()
})
