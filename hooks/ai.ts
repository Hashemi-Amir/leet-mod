import type { EngineInterface } from 'claude-code'

import type { CatalogEntry, ChatMessage, ProblemFile, RunReport, Spec } from '../types'

export const MODEL = 'sonnet'

const tag = (text: string, name: string) =>
  text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()

async function ask($: EngineInterface, system: string, prompt: string, maxTokens: number) {
  const reply = await $.model.complete({ model: MODEL, system, prompt, maxTokens, timeoutMs: 300_000 })
  if (!reply.isAnswered) {
    throw new Error(reply.reason === 'api-error' ? `Claude API error ${reply.status}` : `no reply (${reply.reason})`)
  }

  return reply.text
}

const GENERATE_SYSTEM = `You prepare classic LeetCode problems for a TypeScript interview-practice tool that runs real tests locally with node.

Restate the named LeetCode problem faithfully in your own words: same task, same constraints, same edge-case semantics. Then output exactly four tagged sections and nothing else:

<meta>
A JSON object:
{
  "kind": "function" | "class",
  "functionName": "camelCase name, for kind=function",
  "className": "PascalCase name, for kind=class (design problems such as Min Stack, LRU Cache)",
  "params": [{ "name": "nums", "type": "number[]", "struct": "list" | "tree" | "listArray" (only when the param is a ListNode, TreeNode or ListNode[]) }],
  "returns": { "type": "boolean", "struct": "list" | "tree" | "listArray" (only for node returns) },
  "compare": "exact" | "unordered" (top-level order does not matter) | "unorderedDeep" (neither outer nor inner order matters, e.g. 3Sum, Subsets) | "float" (1e-5 tolerance),
  "mutates": null, or the index of the param the function modifies in place when it returns void (Rotate Image, Reorder List),
  "constraints": ["1 <= nums.length <= 10^5", ...],
  "followUp": "optional follow-up line from the original problem",
  "examples": [2-3 cases, each { "args": [...], "explanation": "optional one line" }],
  "tests": [10-14 hidden cases]
}
Cases for kind=function: { "args": [one JSON value per param] }. Lists and trees are JSON arrays, trees in LeetCode level order with null for gaps.
Cases for kind=class: { "ops": ["MinStack", "push", "getMin"], "args": [[], [3], []] }, the first op being the constructor.
Add 1-2 stress cases for problems where complexity matters: { "gen": "a JavaScript expression returning the args array, e.g. [Array.from({ length: 100000 }, (_, i) => i * 7 % 1000), 42]", "label": "100,000 values" }. Keep them within the constraints. Never write expected outputs anywhere: they are computed by running your reference.
Cover edge cases: empty or single element where allowed, duplicates, negatives, all-equal values, boundaries of the constraints, worst-case shapes.
Prefer inputs with exactly one correct output. When order varies use compare; when several different answers would be valid and compare cannot normalize them, choose inputs whose answer is unique.
Where LeetCode passes node references (Lowest Common Ancestor's p and q, Clone Graph's node), adapt to plain values (node values, adjacency lists) and say so in the statement.
</meta>
<statement>
Markdown: the problem description only, with inline code for names. No title, no examples, no constraints (the tool renders those).
</statement>
<starter>
The TypeScript starter file, LeetCode style: \`export function name(...): Type {\\n\\n}\` or an exported class with empty method bodies. If it uses ListNode or TreeNode, first line: import { ListNode, TreeNode } from '../lib/structures.ts' (only the ones used). No solution code, no comments beyond one line naming the problem.
</starter>
<reference>
A correct, optimal, deterministic TypeScript solution with the exact same exports and imports as the starter. Plain TypeScript: no enums, no namespaces, no external packages.
</reference>`

export type Generated = { statement: string; starter: string; reference: string; spec: Spec }

export async function generateProblem(
  $: EngineInterface,
  entry: CatalogEntry,
  retryNote?: string,
): Promise<Generated> {
  const prompt = [
    `LeetCode #${entry.id}: ${entry.title} (${entry.difficulty}, pattern: ${entry.pattern}).`,
    retryNote && `Your previous attempt failed: ${retryNote}. Fix that.`,
  ]
    .filter(Boolean)
    .join('\n')
  const text = await ask($, GENERATE_SYSTEM, prompt, 16000)
  const meta = tag(text, 'meta')
  const statement = tag(text, 'statement')
  const starter = tag(text, 'starter')?.replace(/^```\w*\n|```$/g, '')
  const reference = tag(text, 'reference')?.replace(/^```\w*\n|```$/g, '')
  if (!meta || !statement || !starter || !reference) throw new Error('the reply missed a section')
  const spec = JSON.parse(meta.replace(/^```\w*\n|```$/g, '')) as Spec

  return { statement, starter: `${starter.trim()}\n`, reference: `${reference.trim()}\n`, spec }
}

const problemBrief = (file: ProblemFile) =>
  `Problem: LeetCode #${file.entry.id} ${file.entry.title} (${file.entry.difficulty}, pattern ${file.entry.pattern})\n\n${file.statement}\n\nConstraints:\n${file.spec.constraints.join('\n')}`

const reportBrief = (report: RunReport | null) => {
  if (report === null) return 'No run yet.'
  const head = `Last ${report.kind}: ${report.verdict}, ${report.passed}/${report.total} passed.`
  const f = report.failing
  const failing = f && `Failing case: ${f.input}\nexpected ${f.expected ?? '?'}, got ${f.got ?? '?'}${f.error ? `\nerror: ${f.error}` : ''}`
  const logs = f?.logs && `What it printed on that case:\n${f.logs.slice(0, 600)}`

  return [head, report.compileError, failing, logs].filter(Boolean).join('\n')
}

// Line numbers as the editor's gutter shows them, so the coach can say "line 12".
const numbered = (code: string) => code.split('\n').map((line, i) => `${String(i + 1).padStart(3, ' ')}  ${line}`).join('\n')

// What the learner changed since their previous question, as - and + lines (an LCS over lines).
export function lineDiff(before: string, after: string, limit = 60) {
  const a = before.split('\n')
  const b = after.split('\n')
  const keep: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      keep[i]![j] = a[i] === b[j] ? keep[i + 1]![j + 1]! + 1 : Math.max(keep[i + 1]![j]!, keep[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (j < b.length && (i >= a.length || keep[i]![j + 1]! > keep[i + 1]![j]!)) {
      out.push(`+ ${b[j]}`)
      j++
    } else {
      out.push(`- ${a[i]}`)
      i++
    }
  }

  return out.length > limit ? [...out.slice(0, limit), `… ${out.length - limit} more changed lines`].join('\n') : out.join('\n')
}

const REVIEW_SYSTEM = `You review an accepted LeetCode solution for someone preparing for coding interviews in TypeScript. Be concrete and brief. Output exactly:
<review>
Markdown, at most ~200 words:
**Complexity:** time and space of THEIR code, one line each with the reason.
**Optimal?** compare with the best known approach; if theirs is slower, name the better complexity without writing its code.
**Good:** 1-2 bullets.
**Improve:** 1-3 bullets on correctness risks, readability, TypeScript idioms or interview communication. No full rewrites.
</review>
<question>
One short explain-back question that makes them name, in their own words, the signal that points to the "PATTERN" pattern in this problem and the key idea of their solution.
</question>`

export async function reviewAccepted($: EngineInterface, file: ProblemFile, code: string) {
  const text = await ask(
    $,
    REVIEW_SYSTEM.replace('PATTERN', file.entry.pattern),
    `${problemBrief(file)}\n\nTheir accepted solution:\n\`\`\`ts\n${code}\n\`\`\``,
    1500,
  )

  return { review: tag(text, 'review') ?? text, question: tag(text, 'question') ?? 'What told you which pattern to use here?' }
}

const tutorSystem = (file: ProblemFile, reference: string) => `You are a Socratic coding coach inside a LeetCode practice hub. The learner is solving the problem below in TypeScript.

Coach the learner's own solution, not the one you would write:
- First work out, from their code, which approach they are taking (brute force, sorting, hashing, two pointers, ...) and how far it has got. Your hint is the next step, bug or edge case of that approach, in their variable names and line numbers ("the inner loop on line 12").
- The reference solution below is a correctness oracle for you, not a target. While their approach can still be correct, never steer them toward the reference, never tell them to delete, restart or rewrite their code.
- Suggest another approach only when theirs cannot be correct, or it is too slow (Time Limit Exceeded), or they ask about efficiency; then build it from what they wrote ("your nested loops compare every pair; what could remember the values already seen?").
- A correct but slower approach is fine: say so, let them finish it, and raise the better complexity as a follow-up once it passes.
- When the file is still the starter, help them find an approach of their own: work an example by hand, try brute force first.
- Use what changed since their last question: acknowledge progress, and don't repeat a hint they have already acted on.

Hint levels, when they press Hint: 1, a question pointing at where to look; 2, name the specific issue or next step in their code; 3, describe that step concretely in words, or one line of code at most. Never the full solution.

Rules:
- Never write the solution or its key lines, never paste the reference, unless the learner explicitly asks to be shown the answer ("show me", "give me the solution"); even then, suggest they press Give up to see the editorial.
- One idea per reply, under 120 words. End with a question when it helps them think.
- Point at a failing input and ask them to trace it through their code, rather than naming the bug outright (below hint level 3).
- Name patterns, data structures and complexity targets freely: that is what they are here to learn.
- Plain markdown; short code only for syntax questions unrelated to the core algorithm.

${problemBrief(file)}

Reference solution (secret, for your guidance only):
\`\`\`ts
${reference}
\`\`\``

export async function tutorReply(
  $: EngineInterface,
  file: ProblemFile,
  reference: string,
  code: string,
  report: RunReport | null,
  chat: ChatMessage[],
  hintLevel: number,
) {
  const transcript = chat
    .slice(-16)
    .map(m => `${m.role === 'you' ? 'Learner' : 'Coach'}: ${m.text}`)
    .join('\n\n')
  // The learner's message before this one carries the code they had then.
  const earlier = chat.slice(0, -1).reverse().find(m => m.role === 'you' && m.code !== undefined)?.code
  const isStarter = code.trim() === file.starter.trim()
  const progress = isStarter
    ? 'Their file is still the starter: they have not written anything yet.'
    : earlier === undefined
      ? 'This is their first question on this problem.'
      : earlier === code
        ? 'Their code has not changed since their previous question.'
        : `What they changed since their previous question:\n\`\`\`diff\n${lineDiff(earlier, code)}\n\`\`\``
  const instruction = hintLevel > 0 ? `They pressed Hint: give a level ${hintLevel} hint.` : "Reply to the learner's last message."

  return ask(
    $,
    tutorSystem(file, reference),
    `Their current solution.ts, with line numbers:\n\`\`\`ts\n${numbered(code)}\n\`\`\`\n\n${progress}\n\n${reportBrief(report)}\n\nConversation so far:\n${transcript}\n\nAs the Coach: ${instruction}`,
    700,
  )
}

const CARD_SYSTEM = `A learner just solved a LeetCode problem and answered an explain-back question. Output exactly:
<feedback>
Two to four sentences: confirm what they got right, correct or sharpen what was vague, in a warm, direct tone.
</feedback>
<card>
A pattern card in markdown, for their personal notebook, starting with a level-3 heading "### #ID TITLE (DIFFICULTY)":
- **Recognize it:** the signals in a problem statement that point to this pattern.
- **Key idea:** one or two sentences.
- **Template:** a short generic TypeScript skeleton of the pattern (not this problem's full solution).
- **Complexity:** time / space.
- **In their words:** a one-line paraphrase of their answer.
- **Pitfalls:** 1-2 bullets.
</card>`

export async function explainBack(
  $: EngineInterface,
  file: ProblemFile,
  code: string,
  question: string,
  answer: string,
) {
  const text = await ask(
    $,
    CARD_SYSTEM,
    `${problemBrief(file)}\n\nTheir solution:\n\`\`\`ts\n${code}\n\`\`\`\n\nQuestion: ${question}\nTheir answer: ${answer || '(skipped)'}\n\nID=${file.entry.id} TITLE=${file.entry.title} DIFFICULTY=${file.entry.difficulty}`,
    1500,
  )

  return { feedback: tag(text, 'feedback') ?? '', card: tag(text, 'card') ?? text }
}

const EDITORIAL_SYSTEM = `Write a LeetCode-style editorial in markdown for someone preparing for interviews in TypeScript:
## Intuition (how to think your way to it, starting from brute force)
## Approach (numbered steps)
## Complexity (time and space with reasons)
## Code (the given reference, cleaned up, in a ts fence, with a few comments only where non-obvious)
## Pattern takeaway (when this pattern applies, and what to reuse next time)
At most ~450 words outside the code.`

export async function writeEditorial($: EngineInterface, file: ProblemFile, reference: string) {
  return ask($, EDITORIAL_SYSTEM, `${problemBrief(file)}\n\nReference solution:\n\`\`\`ts\n${reference}\n\`\`\``, 3000)
}
