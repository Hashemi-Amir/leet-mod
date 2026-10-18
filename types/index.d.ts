export type Difficulty = 'Easy' | 'Medium' | 'Hard'

export type CatalogEntry = {
  id: number
  title: string
  slug: string
  difficulty: Difficulty
  pattern: string
}

export type Review = { stage: number; due: string }

export type Timer = { startedAt: number; limitMs: number; isTimeUp?: boolean }

export type ProblemRecord = {
  slug: string
  status: 'attempted' | 'solved'
  // Counters for the current attempt; a review restart zeroes them.
  failedSubmits: number
  tutorAsks: number
  isGivenUp: boolean
  // Fixed at the first Accepted: solved without giving up first. Mastery counts these.
  isClean?: boolean
  solvedAt?: number
  review?: Review
  timer?: Timer
  isEditorialUnlocked: boolean
  hasExplained: boolean
}

export type Daily = { day: string; slug: string; isDone: boolean }

export type Progress = {
  version: 1
  problems: Record<string, ProblemRecord>
  daily: Daily | null
  streak: { count: number; lastDay: string | null }
}

export type Struct = 'list' | 'tree' | 'listArray'

export type Param = { name: string; type: string; struct?: Struct }

export type TestCase =
  | { args: unknown[]; explanation?: string }
  | { gen: string; label: string }
  | { ops: string[]; args: unknown[][]; explanation?: string }

export type Spec = {
  kind: 'function' | 'class'
  functionName?: string
  className?: string
  params: Param[]
  returns: { type: string; struct?: Struct }
  compare: 'exact' | 'unordered' | 'unorderedDeep' | 'float'
  mutates?: number | null
  constraints: string[]
  followUp?: string
  examples: TestCase[]
  tests: TestCase[]
  // Filled by running the reference solution, never by the model.
  expected?: unknown[]
  refMs?: number[]
}

export type ProblemFile = {
  entry: CatalogEntry
  statement: string
  starter: string
  spec: Spec
  createdAt: number
}

export type Verdict =
  | 'Accepted'
  | 'Wrong Answer'
  | 'Runtime Error'
  | 'Time Limit Exceeded'
  | 'Compile Error'

export type CaseResult = {
  index: number
  isPass: boolean
  input: string
  expected?: string
  got?: string
  error?: string
  ms: number
  logs?: string
}

export type RunReport = {
  kind: 'run' | 'submit'
  verdict: Verdict
  passed: number
  total: number
  cases: CaseResult[]
  failing?: CaseResult
  ms: number
  compileError?: string
  // What the file printed while it loaded, before any case ran.
  loadLogs?: string
  at: number
}

export type Submission = RunReport & { code: string }

export type ChatMessage = {
  role: 'you' | 'tutor'
  text: string
  at: number
  // On the learner's messages: solution.ts as it stood, so the tutor sees what changed between questions.
  code?: string
  // Asked with the Hint button: repeated presses on unchanged code get more concrete.
  isHint?: boolean
}

export type Tab = 'home' | 'problem' | 'tutor' | 'history' | 'list' | 'notebook'

export type View = {
  tab: Tab
  listDifficulty: string
  listPattern: string
  listStatus: string
  nextLevel: string
  submissionIndex: number | null
  // The case whose console output shows; null: the first one that printed.
  consoleCase: number | null
  notebookPattern: string | null
  isConfirmingGiveUp: boolean
  isStatementHidden: boolean
  // Surfaces where the custom editor cannot take the keyboard use a plain text box unless switched.
  isCustomEditorForced: boolean
}

// The problem open in the hub, loaded from disk.
export type Open = {
  slug: string
  file: ProblemFile
  dir: string
  report: RunReport | null
  review: string | null
  editorial: string | null
  chat: ChatMessage[]
  submissions: Submission[]
  // Set after Accepted while Claude's explain-back question waits for an answer.
  question: string | null
  // What the in-pane editor starts from; a new version replaces its buffer.
  code: string
  codeVersion: number
  // When the tutor chat was last cleared; a new value gives the Ask box a fresh start.
  chatClearedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    leet: {
      progress: Progress
      today: string
      view: View
      open: Open | null
      busy: string | null
      tick: number
      isHubOpen: boolean
      bandHiddenDay: string
      notebook: string
      // Why the in-pane editor failed, per surface; that surface then shows code read-only.
      editorFaults: Record<string, string>
    }
  }
}
