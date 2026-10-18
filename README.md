# leet

A LeetCode hub inside Claude Code. Open it with `/leet`:

- **Daily problem** on a pattern roadmap (NeetCode order), starting from Easy. Three clean solves unlock the next level and the next pattern; problems you struggled with come back for review at 3, 7 and 21 days.
- **Problems written by Claude**, then judged on your machine with Node against the examples (Run) and hidden tests (Submit), with LeetCode's verdicts: Accepted, Wrong Answer, Runtime Error, Compile Error, Time Limit Exceeded.
- **An editor in the pane** for TypeScript, with selection, undo, a toolbar and a console that shows each case's `console.log` output.
- **A Socratic tutor** that sees your code and last run and nudges rather than tells, a review from Claude after Accepted, an explain-back question that writes a pattern card to your notebook, and an editorial after Accepted or Give up.
- **Progress**: streak, solved counts, submission history, an interview timer, and Previous/Next through a pattern.

Your solutions are kept in `~/leetcode`, one folder per problem, as a git repository.

## Install

At the prompt of a terminal session:

```
/plugin install leet --marketplace Hashemi-Amir/leet-mod
```

Answer `y` to add the marketplace, then pick a scope (the user scope first, chosen with Enter).

From a shell:

```
claude plugin install leet --marketplace Hashemi-Amir/leet-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Hashemi-Amir/leet-mod`, then Add plugin.

## Requirements

- Node 22.6 or later on your `PATH` (solutions run with Node's TypeScript type stripping).
- `git`, for the `~/leetcode` repository.
