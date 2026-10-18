import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'


// The text model: pure functions over an immutable buffer, kept in this one file because a remote
// surface (the desktop app) loads the surface module on its own.
export type Pos = { row: number; col: number }

export type Buffer = {
  lines: string[]
  row: number
  col: number
  // The column Up/Down try to return to across shorter lines.
  goal: number
  // The fixed end of a selection; the cursor is the moving end.
  anchor?: Pos | null
}

export type History = { undo: Buffer[]; redo: Buffer[]; lastKind: string; streak: number }

const INDENT = '  '
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
const CLOSERS = new Set([')', ']', '}'])
const QUOTES = new Set(['"', "'", '`'])

export const fromText = (text: string): Buffer => ({
  lines: text.replace(/\r\n?/g, '\n').replace(/\t/g, INDENT).split('\n'),
  row: 0,
  col: 0,
  goal: 0,
})

export const toText = (b: Buffer) => b.lines.join('\n')

const line = (b: Buffer, row = b.row) => b.lines[row] ?? ''
const leading = (s: string) => s.match(/^ */)?.[0] ?? ''
const at = (b: Buffer, row: number, col: number): Buffer => ({ ...b, row, col, goal: col })

const replaceLines = (b: Buffer, from: number, to: number, next: string[], row: number, col: number): Buffer => ({
  lines: [...b.lines.slice(0, from), ...next, ...b.lines.slice(to + 1)],
  row,
  col,
  goal: col,
})

// Inserts text as typed or pasted, without auto-closing or auto-indent.
export const insertRaw = (b: Buffer, text: string): Buffer => {
  const parts = text.replace(/\r\n?/g, '\n').replace(/\t/g, INDENT).split('\n')
  const current = line(b)
  const before = current.slice(0, b.col)
  const after = current.slice(b.col)
  if (parts.length === 1) return replaceLines(b, b.row, b.row, [before + parts[0] + after], b.row, b.col + parts[0]!.length)
  const last = parts[parts.length - 1]!
  const middle = parts.slice(1, -1)

  return replaceLines(
    b,
    b.row,
    b.row,
    [before + parts[0], ...middle, last + after],
    b.row + parts.length - 1,
    last.length,
  )
}

export const typeChar = (b: Buffer, ch: string): Buffer => {
  const current = line(b)
  const next = current[b.col]
  // Typing the closer that is already there steps over it.
  if ((CLOSERS.has(ch) || QUOTES.has(ch)) && next === ch) return at(b, b.row, b.col + 1)
  // A closing brace on a blank line lines up with its opening line.
  if (ch === '}' && current.trim() === '' && b.col === current.length && current.length >= INDENT.length) {
    const trimmed = current.slice(INDENT.length)

    return replaceLines(b, b.row, b.row, [`${trimmed}}`], b.row, trimmed.length + 1)
  }
  const close = PAIRS[ch]
  const isOpenRoom = next === undefined || next === ' ' || CLOSERS.has(next)
  const prev = current[b.col - 1]
  const isWordBefore = prev !== undefined && /\w/.test(prev)
  if (close && isOpenRoom && !(QUOTES.has(ch) && isWordBefore)) {
    const moved = insertRaw(b, ch + close)

    return at(moved, moved.row, moved.col - 1)
  }

  return insertRaw(b, ch)
}

export const newline = (b: Buffer): Buffer => {
  const current = line(b)
  const before = current.slice(0, b.col)
  const after = current.slice(b.col)
  const base = leading(current)
  const opener = before.trimEnd().slice(-1)
  const isOpen = opener === '{' || opener === '[' || opener === '('
  const indent = isOpen ? base + INDENT : base
  // Enter between a pair puts the closer on its own line.
  if (isOpen && after.trimStart()[0] === PAIRS[opener]) {
    return replaceLines(b, b.row, b.row, [before, indent, base + after.trimStart()], b.row + 1, indent.length)
  }

  return replaceLines(b, b.row, b.row, [before, indent + after.trimStart()], b.row + 1, indent.length)
}

export const backspace = (b: Buffer): Buffer => {
  const current = line(b)
  if (b.col === 0) {
    if (b.row === 0) return b
    const above = line(b, b.row - 1)

    return replaceLines(b, b.row - 1, b.row, [above + current], b.row - 1, above.length)
  }
  const prev = current[b.col - 1]!
  const next = current[b.col]
  if (PAIRS[prev] !== undefined && PAIRS[prev] === next) {
    return replaceLines(b, b.row, b.row, [current.slice(0, b.col - 1) + current.slice(b.col + 1)], b.row, b.col - 1)
  }
  // In leading whitespace, Backspace removes one indent level.
  const isIndent = current.slice(0, b.col).trim() === ''
  const width = isIndent ? (b.col % INDENT.length || INDENT.length) : 1

  return replaceLines(b, b.row, b.row, [current.slice(0, b.col - width) + current.slice(b.col)], b.row, b.col - width)
}

export const deleteForward = (b: Buffer): Buffer => {
  const current = line(b)
  if (b.col < current.length) {
    return replaceLines(b, b.row, b.row, [current.slice(0, b.col) + current.slice(b.col + 1)], b.row, b.col)
  }
  if (b.row === b.lines.length - 1) return b

  return replaceLines(b, b.row, b.row + 1, [current + line(b, b.row + 1)], b.row, b.col)
}

export const indent = (b: Buffer): Buffer => insertRaw(b, ' '.repeat(INDENT.length - (b.col % INDENT.length)))

export const dedent = (b: Buffer): Buffer => {
  const current = line(b)
  const cut = Math.min(INDENT.length, leading(current).length)
  if (cut === 0) return b

  return replaceLines(b, b.row, b.row, [current.slice(cut)], b.row, Math.max(0, b.col - cut))
}

export const move = (b: Buffer, key: string, page: number, isWord = false): Buffer => {
  const current = line(b)
  const last = b.lines.length - 1
  const vertical = (row: number) => ({ ...b, row, col: Math.min(b.goal, line(b, row).length) })
  switch (key) {
    case 'left':
      if (isWord) {
        const head = current.slice(0, b.col).replace(/\w+\W*$|\W+$/, '')
        return b.col > 0 ? at(b, b.row, head.length) : b.row > 0 ? at(b, b.row - 1, line(b, b.row - 1).length) : b
      }
      return b.col > 0 ? at(b, b.row, b.col - 1) : b.row > 0 ? at(b, b.row - 1, line(b, b.row - 1).length) : b
    case 'right':
      if (isWord) {
        const tail = current.slice(b.col).match(/^\W*\w+|^\W+/)?.[0] ?? ''
        return b.col < current.length ? at(b, b.row, b.col + tail.length) : b.row < last ? at(b, b.row + 1, 0) : b
      }
      return b.col < current.length ? at(b, b.row, b.col + 1) : b.row < last ? at(b, b.row + 1, 0) : b
    case 'up':
      return b.row > 0 ? vertical(b.row - 1) : at(b, 0, 0)
    case 'down':
      return b.row < last ? vertical(b.row + 1) : at(b, last, line(b, last).length)
    case 'pageup':
      return vertical(Math.max(0, b.row - page))
    case 'pagedown':
      return vertical(Math.min(last, b.row + page))
    case 'home': {
      // Home goes to the first non-blank character, then to column 0.
      const first = leading(current).length
      return at(b, b.row, b.col === first ? 0 : first)
    }
    case 'end':
      return at(b, b.row, current.length)
    default:
      return b
  }
}

export const placeAt = (b: Buffer, row: number, col: number): Buffer => {
  const r = Math.max(0, Math.min(b.lines.length - 1, row))

  return at(b, r, Math.max(0, Math.min(line(b, r).length, col)))
}

const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col)

export const selection = (b: Buffer): { start: Pos; end: Pos } | null => {
  const a = b.anchor
  if (!a || (a.row === b.row && a.col === b.col)) return null
  const cursor = { row: b.row, col: b.col }

  return before(a, cursor) ? { start: a, end: cursor } : { start: cursor, end: a }
}

export const selectedText = (b: Buffer) => {
  const sel = selection(b)
  if (!sel) return ''
  const { start, end } = sel
  if (start.row === end.row) return line(b, start.row).slice(start.col, end.col)

  return [
    line(b, start.row).slice(start.col),
    ...b.lines.slice(start.row + 1, end.row),
    line(b, end.row).slice(0, end.col),
  ].join('\n')
}

export const deleteSelection = (b: Buffer): Buffer => {
  const sel = selection(b)
  if (!sel) return { ...b, anchor: null }
  const { start, end } = sel
  const joined = line(b, start.row).slice(0, start.col) + line(b, end.row).slice(end.col)

  return replaceLines(b, start.row, end.row, [joined], start.row, start.col)
}

// Moves the cursor and keeps (or starts) a selection from where it was.
export const extend = (b: Buffer, moved: (b: Buffer) => Buffer): Buffer => {
  const anchor = b.anchor ?? { row: b.row, col: b.col }

  return { ...moved({ ...b, anchor: null }), anchor }
}

export const selectAll = (b: Buffer): Buffer => {
  const last = b.lines.length - 1

  return { ...b, anchor: { row: 0, col: 0 }, row: last, col: line(b, last).length, goal: line(b, last).length }
}

export const selectWord = (b: Buffer, row: number, col: number): Buffer => {
  const text = line(b, row)
  const isWord = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch)
  let from = Math.min(col, text.length)
  let to = from
  if (!isWord(text[from]) && isWord(text[from - 1])) from -= 1
  if (!isWord(text[from])) return placeAt(b, row, col)
  while (isWord(text[from - 1])) from -= 1
  to = from
  while (isWord(text[to])) to += 1

  return { ...b, anchor: { row, col: from }, row, col: to, goal: to }
}

export const wrapSelection = (b: Buffer, open: string, close: string): Buffer => {
  const sel = selection(b)
  if (!sel) return b
  const inner = selectedText(b)
  const cut = deleteSelection(b)
  const wrapped = insertRaw(cut, open + inner + close)
  const end = insertRaw(cut, open + inner)

  return { ...wrapped, anchor: { row: sel.start.row, col: sel.start.col + open.length }, row: end.row, col: end.col, goal: end.col }
}

// Tab and Shift+Tab over a selection shift every line it touches.
export const shiftLines = (b: Buffer, direction: 1 | -1): Buffer => {
  const sel = selection(b)
  if (!sel) return direction === 1 ? indent(b) : dedent(b)
  const last = sel.end.col === 0 && sel.end.row > sel.start.row ? sel.end.row - 1 : sel.end.row
  const lines = [...b.lines]
  const shift: number[] = []
  for (let r = sel.start.row; r <= last; r++) {
    const text = lines[r] ?? ''
    const cut = direction === 1 ? INDENT.length : -Math.min(INDENT.length, leading(text).length)
    lines[r] = direction === 1 ? (text === '' ? text : INDENT + text) : text.slice(-cut)
    shift[r] = direction === 1 && text === '' ? 0 : cut
  }
  const adjust = (p: Pos): Pos => ({ row: p.row, col: Math.max(0, p.col + (shift[p.row] ?? 0)) })
  const cursor = adjust({ row: b.row, col: b.col })

  return { lines, row: cursor.row, col: cursor.col, goal: cursor.col, anchor: adjust(b.anchor!) }
}

export const emptyHistory = (): History => ({ undo: [], redo: [], lastKind: '', streak: 0 })

// Records the state before an edit; runs of the same kind of typing undo together.
export const remember = (h: History, before: Buffer, kind: string): History => {
  const isSameRun = kind === h.lastKind && h.streak < 30 && (kind === 'type' || kind === 'delete')
  if (isSameRun) return { ...h, redo: [], streak: h.streak + 1 }

  return { undo: [...h.undo.slice(-199), before], redo: [], lastKind: kind, streak: 1 }
}

export const undo = (h: History, b: Buffer): { h: History; b: Buffer } => {
  const prev = h.undo[h.undo.length - 1]
  if (!prev) return { h, b }

  return { h: { undo: h.undo.slice(0, -1), redo: [...h.redo, b], lastKind: '', streak: 0 }, b: prev }
}

export const redo = (h: History, b: Buffer): { h: History; b: Buffer } => {
  const next = h.redo[h.redo.length - 1]
  if (!next) return { h, b }

  return { h: { undo: [...h.undo, b], redo: h.redo.slice(0, -1), lastKind: '', streak: 0 }, b: next }
}

export type Token = { text: string; kind: 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'type' | 'fn' }

const KEYWORDS = new Set(
  'const let var function return if else for while do break continue new class extends implements interface type export import from of in as typeof instanceof void null undefined true false this throw try catch finally switch case default readonly public private protected static async await yield keyof enum'.split(' '),
)
const TYPES = new Set('number string boolean any unknown never object bigint symbol'.split(' '))

// Highlights one line; `inComment` carries an open /* */ block across lines.
export const tokenize = (text: string, inComment: boolean): { tokens: Token[]; inComment: boolean } => {
  const tokens: Token[] = []
  let i = 0
  let open = inComment
  const push = (t: string, kind: Token['kind']) => t && tokens.push({ text: t, kind })
  while (i < text.length) {
    if (open) {
      const end = text.indexOf('*/', i)
      const stop = end < 0 ? text.length : end + 2
      push(text.slice(i, stop), 'comment')
      open = end < 0
      i = stop
      continue
    }
    const rest = text.slice(i)
    if (rest.startsWith('//')) {
      push(rest, 'comment')
      break
    }
    if (rest.startsWith('/*')) {
      open = true
      continue
    }
    const ch = text[i]!
    if (QUOTES.has(ch)) {
      let j = i + 1
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1
      push(text.slice(i, j + 1), 'string')
      i = j + 1
      continue
    }
    const number = rest.match(/^\d[\d_]*(\.\d+)?(e[+-]?\d+)?n?/i)
    if (number) {
      push(number[0], 'number')
      i += number[0].length
      continue
    }
    const word = rest.match(/^[A-Za-z_$][\w$]*/)
    if (word) {
      const w = word[0]
      const isCall = text[i + w.length] === '('
      push(w, KEYWORDS.has(w) ? 'keyword' : TYPES.has(w) || /^[A-Z]/.test(w) ? 'type' : isCall ? 'fn' : 'plain')
      i += w.length
      continue
    }
    const plain = rest.match(/^[^A-Za-z_$\d"'`/]+|^\//)?.[0] ?? ch
    push(plain, 'plain')
    i += plain.length
  }

  return { tokens, inComment: open }
}

export type EditorProps = { slug: string; text: string; version: number; rows?: number; columns?: number }

// Browser-style key names, as a web surface may send them, mapped to the terminal's.
const KEY_NAMES: Record<string, string> = {
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  up: 'up', down: 'down', left: 'left', right: 'right',
  enter: 'return', return: 'return', tab: 'tab', backspace: 'backspace', delete: 'delete', del: 'delete',
  pageup: 'pageup', pagedown: 'pagedown', home: 'home', end: 'end', escape: 'escape', esc: 'escape',
  space: ' ', spacebar: ' ', insert: 'insert', backtab: 'backtab',
}
const MODIFIERS = new Set(['shift', 'control', 'ctrl', 'alt', 'meta', 'os', 'capslock', 'numlock', 'altgraph', 'fn', 'super', 'hyper'])

// Keeps what a paste carries and drops everything a terminal sends as control: a bracketed-paste
// wrapper is unwrapped, any other escape sequence is a key this editor does not know and is ignored.
export const cleanInput = (raw: string): string | null => {
  const unwrapped = raw.replace(/\x1b\[200~|\x1b\[201~/g, '')
  if (unwrapped.includes('\x1b')) return null
  const text = unwrapped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, '')

  return text === '' ? null : text
}

// What a line may draw: a stray control character in the file is shown, never sent to the surface.
export const visible = (ch: string) => (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(ch) ? '\u00b7' : ch)

// Some terminals hand Ctrl+letter over as its control character and Alt+letter as Esc then the letter.
const decode = (ev: ClientKeyEvent): ClientKeyEvent => {
  const code = ev.key.length === 1 ? ev.key.charCodeAt(0) : -1
  const isCtrlChar = code >= 1 && code <= 26 && ![8, 9, 10, 13].includes(code)
  if (isCtrlChar) return { ...ev, key: String.fromCharCode(code + 96), ctrl: true }
  if (/^\x1b[a-zA-Z]$/.test(ev.key)) return { ...ev, key: ev.key.slice(1), meta: true }

  return ev
}

const normalizeKey = (key: string): string | null => {
  const lower = key.toLowerCase()
  if (MODIFIERS.has(lower) || /^f\d{1,2}$/.test(lower)) return null
  const named = KEY_NAMES[lower]
  if (named) return named
  // A lone lowercase word is a key name this editor does not know (clear, contextmenu), not a paste.
  if (/^[a-z][a-z0-9]{1,15}$/.test(key)) return null

  return cleanInput(key)
}

// The hub's size wins: the desktop app reports a region only as tall as what was last drawn,
// which would shrink the editor to one line and keep it there.
const sizeOf = (surface: { rows: number; columns: number }, props: EditorProps) => ({
  rows: props.rows ?? (surface.rows > 0 ? surface.rows : 16),
  columns: props.columns ?? (surface.columns > 0 ? surface.columns : 60),
})

type Click = { at: number; row: number; col: number }

type State = {
  b: Buffer
  h: History
  top: number
  left: number
  slug: string
  version: number
  isDragging: boolean
  lastClick: Click | null
  // What Copy or Cut last took, for Paste when the terminal does not paste by itself.
  clip: string
}

const MOVES = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end'])
const COLOR: Record<Token['kind'], string | undefined> = {
  plain: undefined,
  keyword: 'claude',
  string: 'success',
  number: 'warning',
  comment: undefined,
  type: 'permission',
  fn: 'suggestion',
}
const DOUBLE_CLICK_MS = 400

const fresh = (props: EditorProps): State => ({
  b: fromText(typeof props.text === 'string' ? props.text : ''),
  h: emptyHistory(),
  top: 0,
  left: 0,
  slug: props.slug,
  version: props.version,
  isDragging: false,
  lastClick: null,
  clip: '',
})

const gutterOf = (b: Buffer) => String(b.lines.length).length + 1

// Scrolls so the cursor stays inside the region.
// The region's last two rows are the status line and the toolbar.
const FOOTER_ROWS = 2
const viewRows = (rows: number) => Math.max(1, rows - FOOTER_ROWS)

const follow = (s: State, rows: number, columns: number): State => {
  const view = viewRows(rows)
  const width = Math.max(4, columns - gutterOf(s.b) - 1)
  const top = s.b.row < s.top ? s.b.row : s.b.row >= s.top + view ? s.b.row - view + 1 : s.top
  const left = s.b.col < s.left ? s.b.col : s.b.col >= s.left + width ? s.b.col - width + 1 : s.left

  return { ...s, top, left }
}

const now = () => {
  try {
    return Date.now()
  } catch {
    return 0
  }
}

const onKey = (surface: ClientSurface<State>, props: () => EditorProps, raw: ClientKeyEvent) => {
  const s = surface.state
  if (!s) return
  const ev = decode(raw)
  const normalized = normalizeKey(ev.key)
  if (normalized === null) return
  // Letters with Ctrl compare lower-case: some surfaces send "Z" for Ctrl+Shift+Z.
  const key = (ev.ctrl || ev.meta) && normalized.length === 1 ? normalized.toLowerCase() : normalized
  // Claude Code keeps Ctrl+C, Ctrl+X, Ctrl+V and Ctrl+Z for itself, so Alt+letter does the same here.
  const cmd = (ev.ctrl || ev.meta) && key.length === 1 ? key : ''
  const size = sizeOf(surface, props())
  const page = Math.max(1, size.rows - 2)
  const isWordMove = ev.ctrl === true || ev.meta === true
  const sel = selection(s.b)
  let b = s.b
  let h = s.h
  let clip = s.clip
  let copied: string | undefined
  let action: 'run' | undefined
  const edit = (kind: string, next: Buffer) => {
    h = remember(h, s.b, kind)
    b = next
  }
  const moveBy = (from: Buffer) => {
    if (ev.ctrl && key === 'home') return placeAt(from, 0, 0)
    if (ev.ctrl && key === 'end') return placeAt(from, from.lines.length - 1, Infinity)

    return move(from, key, page, isWordMove)
  }

  if (cmd === 'r' || (ev.ctrl && key === 'return')) action = 'run'
  else if (cmd === 'a') b = selectAll(b)
  else if (cmd === 'c' || cmd === 'x') {
    if (!sel) return
    clip = selectedText(b)
    copied = clip
    if (cmd === 'x') edit('cut', deleteSelection(b))
  } else if (cmd === 'v') {
    if (clip) edit('paste', insertRaw(deleteSelection(b), clip))
  } else if (cmd === 'z' && !ev.shift) ({ h, b } = undo(h, b))
  else if (cmd === 'y' || (cmd === 'z' && ev.shift)) ({ h, b } = redo(h, b))
  else if (MOVES.has(key) && ev.shift) b = extend(b, moveBy)
  else if (MOVES.has(key)) {
    // Left and Right first collapse a selection to the side they point at.
    if (sel && !isWordMove && key === 'left') b = { ...placeAt(b, sel.start.row, sel.start.col), anchor: null }
    else if (sel && !isWordMove && key === 'right') b = { ...placeAt(b, sel.end.row, sel.end.col), anchor: null }
    else b = moveBy({ ...b, anchor: null })
  } else if (key === 'return') edit('newline', newline(deleteSelection(b)))
  else if (key === 'backtab' || (key === 'tab' && ev.shift)) edit('indent', shiftLines(b, -1))
  else if (key === 'tab') edit('indent', shiftLines(b, 1))
  else if (key === 'backspace') edit('delete', sel ? deleteSelection(b) : backspace(b))
  else if (key === 'delete') edit('delete', sel ? deleteSelection(b) : deleteForward(b))
  else if (key === 'escape' || key === 'insert' || ev.ctrl || ev.meta) return
  else if ([...key].length === 1) {
    const close = PAIRS[key]
    if (sel && close) edit('wrap', wrapSelection(b, key, close))
    else edit('type', typeChar(deleteSelection(b), key))
  }
  // Anything longer arrived in one piece: a paste.
  else edit('paste', insertRaw(deleteSelection(b), key))

  const isChanged = b.lines !== s.b.lines
  surface.setState(follow({ ...s, b, h, clip }, size.rows, size.columns))
  if (isChanged || action || copied !== undefined) {
    const { slug, version } = props()
    surface.post({
      slug,
      version,
      text: toText(b),
      ...(action ? { action } : {}),
      ...(copied !== undefined ? { clip: copied } : {}),
    })
  }
}

// Clickable stand-ins for the shortcuts the terminal or Claude Code may keep: each is the key it presses.
const TOOLS: { label: string; key: string; shift?: true; group: number }[] = [
  { label: 'Copy', key: 'c', group: 0 },
  { label: 'Cut', key: 'x', group: 0 },
  { label: 'Paste', key: 'v', group: 0 },
  { label: 'Undo', key: 'z', group: 1 },
  { label: 'Redo', key: 'y', group: 1 },
  { label: 'Select all', key: 'a', group: 2 },
  { label: 'Run', key: 'r', group: 3 },
]
const toolbar = (() => {
  let x = 0
  return TOOLS.map((tool, i) => {
    const prev = TOOLS[i - 1]
    const gap = prev === undefined ? 0 : prev.group === tool.group ? 2 : 5
    const from = x + gap
    x = from + tool.label.length

    return { ...tool, gap, from, to: x }
  })
})()
const isToolOn = (s: State, key: string) =>
  key === 'c' || key === 'x' ? selection(s.b) !== null : key === 'v' ? s.clip !== '' : true

const latestProps = (): EditorProps => latest

const onPointer = (surface: ClientSurface<State>, ev: ClientPointerEvent) => {
  const s = surface.state
  if (!s) return
  const size = sizeOf(surface, latest)
  const view = viewRows(size.rows)
  if (ev.y >= view && !s.isDragging) {
    if (ev.type !== 'down' || ev.button !== 'left' || ev.y !== view + 1) return
    const tool = toolbar.find(t => ev.x >= t.from && ev.x < t.to)
    if (tool && isToolOn(s, tool.key)) onKey(surface, latestProps, { key: tool.key, meta: true, ...(tool.shift ? { shift: true } : {}) })
    return
  }
  const row = s.top + ev.y
  const col = s.left + ev.x - gutterOf(s.b)

  if (ev.type === 'down' && ev.button === 'left') {
    const at = now()
    const last = s.lastClick
    const isDouble = last !== null && at - last.at < DOUBLE_CLICK_MS && last.row === row && last.col === col
    const placed = placeAt({ ...s.b, anchor: null }, row, col)
    const b = isDouble ? selectWord(s.b, placed.row, placed.col) : { ...placed, anchor: { row: placed.row, col: placed.col } }
    const size = sizeOf(surface, latest)
    surface.setState(follow({ ...s, b, isDragging: !isDouble, lastClick: isDouble ? null : { at, row, col } }, size.rows, size.columns))
    return
  }
  if (ev.type === 'move' && s.isDragging && ev.button === 'left') {
    const b = extend(s.b, from => placeAt(from, row, col))
    const size = sizeOf(surface, latest)
    surface.setState(follow({ ...s, b }, size.rows, size.columns))
    return
  }
  if (ev.type === 'up' && s.isDragging) {
    // A click without a drag leaves just the cursor.
    const b = selection(s.b) ? s.b : { ...s.b, anchor: null }
    surface.setState({ ...s, b, isDragging: false })
  }
}

let latest: EditorProps = { slug: '', text: '', version: 0 }

const Editor: ClientModule<EditorProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  latest = props
  let s = surface.state
  if (!s) {
    surface.onKey(ev => onKey(surface, () => latest, ev))
    surface.onPointer(ev => onPointer(surface, ev))
  }
  // A new version from the hub (a fresh start, a file edited elsewhere) replaces the buffer.
  if (!s || s.slug !== props.slug || s.version !== props.version) {
    s = fresh(props)
    surface.setState(s)
  }

  const size = sizeOf(surface, props)
  const view = viewRows(size.rows)
  const gutter = gutterOf(s.b)
  const width = Math.max(4, size.columns - gutter - 1)
  const sel = selection(s.b)
  let inComment = false
  for (let r = 0; r < s.top; r++) inComment = tokenize(s.b.lines[r] ?? '', inComment).inComment

  const rows = s.b.lines.slice(s.top, s.top + view).map((text, i) => {
    const row = s.top + i
    const result = tokenize(text, inComment)
    inComment = result.inComment
    const kinds: Token['kind'][] = result.tokens.flatMap(t => [...t.text].map(() => t.kind))
    const chars = [...text]
    // The selected columns of this row; one past the end stands for its line break.
    const from = sel && row >= sel.start.row && row <= sel.end.row ? (row === sel.start.row ? sel.start.col : 0) : -1
    const to = sel && from >= 0 ? (row === sel.end.row ? sel.end.col : chars.length + 1) : -1
    const isCursorRow = !sel && row === s.b.row
    const last = Math.max(chars.length, isCursorRow ? s.b.col + 1 : 0, to)
    const spans: { text: string; kind: Token['kind']; isMarked: boolean }[] = []
    for (let c = s.left; c < Math.min(s.left + width, last); c++) {
      const isMarked = (isCursorRow && c === s.b.col) || (c >= from && c < to)
      const ch = visible(chars[c] ?? ' ')
      const kind = kinds[c] ?? 'plain'
      const prev = spans[spans.length - 1]
      if (prev && prev.kind === kind && prev.isMarked === isMarked && !(isCursorRow && c === s.b.col)) prev.text += ch
      else spans.push({ text: ch, kind, isMarked })
    }

    return (
      <Text key={`l${row}`} wrap="truncate-end" mono>
        <Text mono dimColor>{String(row + 1).padStart(gutter - 1, ' ')} </Text>
        {spans.length === 0 ? ' ' : spans.map((span, j) => (
          <Text key={`s${j}`} mono inverse={span.isMarked} color={COLOR[span.kind]} dimColor={span.kind === 'comment'} italic={span.kind === 'comment'}>
            {span.text}
          </Text>
        ))}
      </Text>
    )
  })

  const picked = sel ? selectedText(s.b) : ''
  const where = sel
    ? `${picked.length} chars${sel.end.row > sel.start.row ? ` on ${sel.end.row - sel.start.row + 1} lines` : ''} selected · Alt+C copy · Alt+X cut`
    : `Ln ${s.b.row + 1}, Col ${s.b.col + 1} · saved as you type · Alt+Z undo · Alt+V paste`
  const state = s

  return (
    <Box flexDirection="column">
      {rows}
      {Array.from({ length: Math.max(0, view - rows.length) }, (_, i) => (
        <Text key={`pad${i}`} mono dimColor>{' '.repeat(gutter - 1)}~</Text>
      ))}
      <Text dimColor wrap="truncate-end">{where} · Esc leaves the editor</Text>
      <Text wrap="truncate-end">
        {toolbar.map(t => (
          <Text key={`tool-${t.key}`}>
            <Text dimColor>{t.gap === 5 ? '  │  ' : ' '.repeat(t.gap)}</Text>
            <Text bold={isToolOn(state, t.key)} dimColor={!isToolOn(state, t.key)} color={t.key === 'r' ? 'claude' : undefined}>{t.label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  )
}

export default Editor
