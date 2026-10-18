import { expect, test } from 'claude-code/testing'
import type { ClientKeyEvent, ClientPointerEvent } from 'claude-code'

import { backspace, cleanInput, fromText, newline, toText, tokenize, typeChar, visible } from './editor'
import Editor from './editor'

// A stand-in surface: records posts and lets the test press keys.
const mountEditor = (text: string) => {
  const posts: unknown[] = []
  let keyListener: (ev: ClientKeyEvent) => void = () => undefined
  let pointerListener: (ev: ClientPointerEvent) => void = () => undefined
  const surface = {
    elements: { Box: (p: unknown) => p, Text: (p: unknown) => p },
    state: undefined as unknown,
    setState(next: unknown) { surface.state = next },
    columns: 60,
    rows: 12,
    every: () => () => undefined,
    onPointer(fn: (ev: ClientPointerEvent) => void) { pointerListener = fn; return () => undefined },
    onKey(fn: (ev: ClientKeyEvent) => void) { keyListener = fn; return () => undefined },
    post(data: unknown) { posts.push(data) },
  }
  const props = { slug: 'two-sum', text, version: 1 }
  Editor(props, surface as unknown as Parameters<typeof Editor>[1])
  const press = (key: string, mods: Omit<ClientKeyEvent, 'key'> = {}) => keyListener({ key, ...mods })
  const type = (s: string) => [...s].forEach(ch => press(ch))
  const lastText = () => (posts[posts.length - 1] as { text: string } | undefined)?.text
  const lastClip = () => (posts[posts.length - 1] as { clip?: string } | undefined)?.clip
  // Pointer cells: the gutter (one digit and a space) comes before column 0.
  const pointer = (type: ClientPointerEvent['type'], row: number, col: number) =>
    pointerListener({ type, x: col + 2, y: row, ...(type === 'up' || type === 'down' || type === 'move' ? { button: 'left' as const } : {}) })

  // A raw click at a region cell, for the toolbar on the region's last row.
  const click = (x: number, y: number) => pointerListener({ type: 'down', x, y, button: 'left' })

  return { press, type, posts, lastText, lastClip, pointer, click }
}

test('typing a function body indents and closes braces like a code editor', async () => {
  const ed = mountEditor('')
  ed.type('function f() {')
  ed.press('return')
  ed.type('return 1')
  expect(ed.lastText()).toBe('function f() {\n  return 1\n}')
})

test('Tab indents, Backspace removes a whole indent level', async () => {
  const ed = mountEditor('')
  ed.press('tab')
  ed.press('tab')
  ed.type('x')
  expect(ed.lastText()).toBe('    x')
  ed.press('left')
  ed.press('backspace')
  expect(ed.lastText()).toBe('  x')
})

test('a paste arrives whole, with its own indentation kept', async () => {
  const ed = mountEditor('')
  ed.press('const a = {\r\n  b: 1,\r\n}')
  expect(ed.lastText()).toBe('const a = {\n  b: 1,\n}')
})

test('Ctrl+Z undoes a run of typing, Ctrl+R asks the hub to run', async () => {
  const ed = mountEditor('x')
  ed.press('end')
  ed.type('yz')
  ed.press('z', { ctrl: true })
  expect(ed.lastText()).toBe('x')
  ed.press('r', { ctrl: true })
  expect(ed.posts[ed.posts.length - 1]).toEqual({ slug: 'two-sum', version: 1, text: 'x', action: 'run' })
})

test('buffer: closers step over, empty pairs delete together', async () => {
  let b = typeChar(fromText(''), '(')
  expect(toText(b)).toBe('()')
  b = typeChar(b, ')')
  expect(b.col).toBe(2)
  b = backspace(typeChar(fromText(''), '['))
  expect(toText(b)).toBe('')
  expect(toText(newline({ ...fromText('if (a) {}'), col: 8 }))).toBe('if (a) {\n  \n}')
})

test('tokenize marks keywords, strings, numbers and comments', async () => {
  const { tokens } = tokenize("const s = 'hi' // note", false)
  expect(tokens.filter(t => t.kind !== 'plain').map(t => [t.kind, t.text])).toEqual([
    ['keyword', 'const'],
    ['string', "'hi'"],
    ['comment', '// note'],
  ])
  expect(tokenize('/* open', false).inComment).toBe(true)
})

test('Shift+arrows select, and typing replaces the selection', async () => {
  const ed = mountEditor('let value = 1')
  for (let i = 0; i < 4; i++) ed.press('right')
  for (let i = 0; i < 5; i++) ed.press('right', { shift: true })
  ed.type('total')
  expect(ed.lastText()).toBe('let total = 1')
})

test('Ctrl+Shift+Right selects by word and Ctrl+A selects everything', async () => {
  const ed = mountEditor('alpha beta\ngamma')
  ed.press('right', { ctrl: true, shift: true })
  ed.press('c', { ctrl: true })
  expect(ed.lastClip()).toBe('alpha')
  ed.press('a', { ctrl: true })
  ed.press('backspace')
  expect(ed.lastText()).toBe('')
})

test('dragging the mouse selects across lines, and Ctrl+X cuts it to the clipboard', async () => {
  const ed = mountEditor('one\ntwo\nthree')
  ed.pointer('down', 0, 1)
  ed.pointer('move', 1, 2)
  ed.pointer('up', 1, 2)
  ed.press('x', { ctrl: true })
  expect(ed.lastClip()).toBe('ne\ntw')
  expect(ed.lastText()).toBe('oo\nthree')
  ed.press('v', { ctrl: true })
  expect(ed.lastText()).toBe('one\ntwo\nthree')
})

test('a click without a drag only moves the cursor; a double-click selects the word', async () => {
  const ed = mountEditor('const total = 1')
  ed.pointer('down', 0, 3)
  ed.pointer('up', 0, 3)
  ed.type('X')
  expect(ed.lastText()).toBe('conXst total = 1')
  ed.pointer('down', 0, 9)
  ed.pointer('up', 0, 9)
  ed.pointer('down', 0, 9)
  ed.press('c', { ctrl: true })
  expect(ed.lastClip()).toBe('total')
})

test('Tab and Shift+Tab shift every selected line; brackets wrap a selection', async () => {
  const ed = mountEditor('a\nb\nc')
  ed.press('down', { shift: true })
  ed.press('end', { shift: true })
  ed.press('tab')
  expect(ed.lastText()).toBe('  a\n  b\nc')
  ed.press('tab', { shift: true })
  expect(ed.lastText()).toBe('a\nb\nc')
  ed.press('a', { ctrl: true })
  ed.type('[')
  expect(ed.lastText()).toBe('[a\nb\nc]')
})

test('Left collapses a selection to its start without deleting', async () => {
  const ed = mountEditor('abcdef')
  ed.press('end')
  ed.press('left', { shift: true })
  ed.press('left', { shift: true })
  ed.press('left')
  ed.type('-')
  expect(ed.lastText()).toBe('abcd-ef')
})

test('an unknown key arriving as an escape sequence changes nothing', async () => {
  const ed = mountEditor('abc')
  ed.press('end')
  ed.press('\x1b[3;5~')
  ed.press('\x1b')
  ed.press('contextmenu')
  ed.press('wheeldown')
  ed.type('d')
  expect(ed.lastText()).toBe('abcd')
})

test('a bracketed paste is unwrapped and stray control characters are dropped', async () => {
  const ed = mountEditor('')
  ed.press('\x1b[200~const a = 1\nconst\x07 b = 2\x1b[201~')
  expect(ed.lastText()).toBe('const a = 1\nconst b = 2')
  expect(cleanInput('\x1b[A')).toBeNull()
  expect(visible('\x1b')).toBe('\u00b7')
})

test('Alt+letter and raw control characters reach copy, cut, paste and undo', async () => {
  const ed = mountEditor('one two')
  ed.press('right', { ctrl: true, shift: true })
  ed.press('c', { meta: true })
  expect(ed.lastClip()).toBe('one')
  ed.press('\x1bx')
  expect(ed.lastText()).toBe(' two')
  ed.press('end')
  ed.press('\x16')
  expect(ed.lastText()).toBe(' twoone')
  ed.press('z', { meta: true })
  expect(ed.lastText()).toBe(' two')
  ed.press('\x1a')
  expect(ed.lastText()).toBe('one two')
})

test('the toolbar row clicks stand in for the shortcuts', async () => {
  // 12 rows: ten of code, the status line, then the toolbar on row 11.
  const ed = mountEditor('alpha beta')
  ed.click(37, 11)
  ed.click(1, 11)
  expect(ed.lastClip()).toBe('alpha beta')
  ed.click(7, 11)
  expect(ed.lastText()).toBe('')
  ed.click(12, 11)
  expect(ed.lastText()).toBe('alpha beta')
  ed.click(22, 11)
  expect(ed.lastText()).toBe('')
  ed.click(52, 11)
  expect((ed.posts[ed.posts.length - 1] as { action?: string }).action).toBe('run')
})
