# Decision panel

How seemly settles a call it should not make alone. Three independent agents decide, a fourth
compares their answers and picks the best-supported one per item, and the human gets one
recommendation with every dissent visible. Majority alone is not enough: two agents that share a
wrong guess outvote one agent that cited the evidence.

This is consensus thinking: several independent answers to one question, compared before
acting. Here a judge compares them on evidence, rather than only counting votes.

## How to invoke

Any of these phrases runs the panel, even outside a clone build:

- `/seemly use consensus thinking to solve the conflicts on <PR link or number>`
- `/seemly use consensus thinking on this error: <paste>`
- `/seemly run the panel on <question>`

The run follows the matching mode below, then gives the report in section 7.

## When the panel runs

Convene a panel for any of these. Everything else is decided by the running agent per
`decisions.md`.

| Trigger | Examples |
|---|---|
| Scope boundary | build or disable a sibling nav item, tab, module; how deep a "build X" goes |
| Unbounded work | how far to seed, crawl, paginate or capture; anything that could run without end |
| Server-side logic | a rule the reference decides on the server and the capture only shows the result of |
| Merge conflict, case (b) or (c) | one side removes what the other relies on; both sides change the same behaviour (`decisions.md` › Merge conflicts) |
| Contested intake call | a build/disable call the agent is not confident in |
| Lessons before a continued build | agreeing the rules a build family runs under (`principles.md`) |
| Error or blocker with more than one plausible fix | a failing migration, a lint or type error whose fix changes behaviour, a CSync failure, a red CI check |
| Human asks | "use consensus thinking", "run the panel", "ask multiple agents" |

Case (a) merge conflicts (both sides only add) do not need a panel: keep both and renumber.

## 1. Brief (written once, sent identically)

Write `discovery/<topic>-panel.md` with a **Brief** section before spawning anyone:

- **Question**, split into numbered **items**, each answerable on its own (one per conflicting
  hunk, one per sibling control). An item is never "resolve the PR"; it is "file X hunk 2: keep
  `cancelled` or `withdrawn` as the request's terminal status".
- **Options** per item, including "neither / something else" where it is real.
- **Evidence**: paths and line ranges, the diff hunks, capture ids, frame ids, doc links. Every
  panelist gets the same list. Do not include your own leaning, a preferred option, or which side
  you wrote: an agent handed a hypothesis tends to confirm it.
- **Source ranking** to apply: live capture > vendor API definition > official job aid / docs >
  video frame > teammate reasoning > guess.
- **Answer format** (below), so the judge can compare like with like.

## 2. Panelists (three, in parallel, independent)

Spawn all three in one message so none sees another's answer. Same brief, different lens:

| Panelist | Lens |
|---|---|
| **Evidence** | decide strictly from the ranked sources; when sources are silent, say so rather than infer |
| **Skeptic** | look for the reason each option is wrong: what breaks, what the other side relied on, what a later PR or flow will collide with |
| **Reviewer** | decide what a human reviewer or grader will notice: fidelity to the reference, a visible regression, a dropped feature, an untested path |

Each panelist returns, per item:

```
item: <n>
choice: <option id | other: ...>
confidence: high | medium | low
evidence: <path:line / capture id / frame id that decides it>   # required; "none" is allowed but weighs nothing
breaks_if_wrong: <what fails if this choice is wrong>
```

Panelists are read-only: no edits, no commits, no PR comments.

## 3. Judge (one, after all three return)

Spawn a fourth agent with the brief and the three answers, labelled A/B/C only (not by lens, so the
judge weighs the argument, not the role). Per item it:

1. **Checks the evidence.** Opens every cited path, capture or frame. A citation that does not
   say what the panelist claims is struck, and that answer drops to "no evidence".
2. **Ranks the surviving answers** by the source ranking. A single answer backed by a stronger
   source beats a majority backed by weaker ones or none.
3. **Breaks ties** in this order: stronger evidence, then keeps pre-existing behaviour on `main`,
   then the smaller change, then majority.
4. **Writes the verdict**: chosen option, why it beat each other answer, and how the vote fell
   (3-0, 2-1, 1-1-1).

The judge is read-only too.

## 4. Escalate instead of deciding

The item goes to the human as a question, with the judge's recommendation first, when any of
these holds:

- the vote is **1-1-1**, or the judge overturns a **3-0** majority;
- no answer has evidence above "teammate reasoning" and the item changes user-visible behaviour;
- the item would delete or rewrite a teammate's work, close a PR, or touch a CODEOWNERS path;
- every panelist's confidence is low.

Everything else a clone build applies without asking, as a standing decision. PR conflict mode
and error mode always wait for the human's go before changing anything.

## 5. Record

Append to `discovery/<topic>-panel.md`:

| item | A | B | C | verdict | vote | deciding evidence | dissent kept as |
|---|---|---|---|---|---|---|---|

Each overruled answer with evidence becomes an `ASSUMPTIONS.md` row (what was assumed, what would
prove it wrong), so the losing side's evidence is recorded, never silently dropped. A merge
conflict report also lists per file: added / removed / changed, which side kept, why.

## 6. Apply

Apply verdicts on your own branch only. Never rewrite a teammate's PR. If a verdict says another
open PR already builds the flow, point at that PR instead of rebuilding it. Run the repo's loop
check after applying, and report what was not verified.

## PR conflict mode

For "solve the conflicts on <PR>":

1. `gh pr view <pr> --json number,title,headRefName,baseRefName,author,mergeable,url`, then
   fetch both refs and test-merge: `git merge-tree --write-tree --name-only <base> <head>`.
   No conflicts: say so, and stop.
2. List every conflicting file and hunk, and classify each one per `decisions.md` › Merge
   conflicts: (a) both add, (b) removes what the other relies on, (c) both change the same
   behaviour.
3. Settle (a) hunks directly: keep both, renumber the side not on the base. Settle a (b) or (c)
   hunk directly only when one side has a strictly stronger source. Every other (b) and (c)
   hunk is an item for **one** panel (sections 1 to 5).
4. **Before touching anything**, give the human the section 7 report: how each hunk will be
   resolved and why. Resolve only after the human says go. If the PR belongs to someone else,
   never push to it: resolve on your own branch or hand the report to its author.
5. Apply, run the repo's loop check, and report the result per file.

## Error mode

For an error or blocker:

1. Reproduce it once and keep the exact output. Read the failing code and its recent history
   (`git log -p -3 -- <file>`). Settle it without a panel if one fix is obviously right.
2. Otherwise the items are the candidate causes and fixes. The brief carries the exact error
   output and the reproduction command. Each panelist proposes a fix and the evidence that its
   cause is the real one.
3. The judge prefers a fix verified by re-running the reproduction (read-only where possible,
   in a scratch worktree otherwise) over one that is only argued.
4. Report per section 7, then apply after the human says go.

## 7. Report: comparison table and channel post

Every panel ends with this report, in chat and at the top of `discovery/<topic>-panel.md`.

**Comparison table**, one row per item:

| # | Item | Evidence agent | Skeptic agent | Reviewer agent | Judge's pick | Vote | Why this pick won |
|---|---|---|---|---|---|---|---|

Each agent column holds its choice and its one-line reason. "Why this pick won" names the
deciding evidence (path:line, capture id, frame id) and why each other answer lost (weaker
source, citation did not hold, breaks a flow on main). Items settled without a panel get a row
too, with "direct" in the vote column and the rule that settled them.

**Then**: what goes to the human (each escalated item as a question, recommendation first) and
the exact resolution plan (per file: which side is kept, what is merged by hand, what is
renumbered).

**Channel post**: a short block the human can paste into the team channel as-is:

```
Consensus check: <PR link | error, one line>
Items: <n> (<k> settled by panel, <m> settled directly, <e> for a human ruling)
Decision: <one line per item: what was kept and why>
Dissent: <any 2-1 or overturned item, one line each, or "none">
Panel record: discovery/<topic>-panel.md
```

No personal data in the post: name PRs, files and branches, never people.

## Cost

Four agents per panel. Batch every item of one question into a single panel; never one panel per
item. A question with one item and one obviously stronger source does not need a panel.
