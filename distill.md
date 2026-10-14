# distill.md: how this skill rewrites itself after a build

Runs automatically at every `SESSION CHECKPOINT` and at `DONE`, after any `STOP`, and
whenever the human says `distill`. **All output goes to `LOCAL/overlay/` and
`LOCAL/corrections/`** (`never_to_be_pushed/seemly-local/`), never to the tracked
skill. Moving learnings into the tracked skill is `promote`, a separate step the human
triggers by name. Inputs: `corrections/<build>/*.md` (the human's mid-run messages, verbatim,
with the step they landed on) and the build's `discovery/LESSONS.md`,
`discovery/ASSUMPTIONS.md`, `discovery/tool-fallbacks.md`. Output: edits to this skill,
each citing its source, plus a printed diff for the human.

## Step 1: collect

Copy the build's `LESSONS.md` and `ASSUMPTIONS.md` into `corrections/<build>/` beside
the human's messages. Number every human message `<nn>.md` in arrival order with a
header: `phase.step`, `what it changed`, `class` (one of: ruling, tooling, capture,
gate, process, scope, pace).

## Step 2: classify each item into exactly one destination

| item says | goes to | as |
|---|---|---|
| a decision the human had to make ("vendor the fonts", "proceed logged in") | `LOCAL/overlay/decisions.md` | new row with origin |
| a tool did not do what was expected, or a workaround was found | `LOCAL/overlay/tool-split.md` | limitation + workaround row |
| content was missing from the capture, or a filter dropped it | `LOCAL/overlay/capture-rules.md` | rule, stated as what to do |
| a defect class reached the human or a gate caught it | `LOCAL/overlay/checks.md` and `LOCAL/overlay/defects.md` | check spec + catalogue row |
| a phase ran in the wrong order, took too long, or stopped when it should not | `LOCAL/overlay/principles.md` (a `promote` may later edit `SKILL.md`) | the rule, citing the correction |
| a recurring failure that a future run could reproduce | `LOCAL/evals/cases-local.md` | a case: setup, the mistake, the expected behaviour |

An item can produce more than one edit only when it is both a ruling and a gate.

## Step 3: apply, with these constraints

- **Never weaken.** A correction that would lower a bar, skip a gate, widen an
  allowlist, or drop a verification tier is recorded in `corrections/` with the note
  `not applied: would weaken <gate>` and is not applied. Pace corrections are applied by
  batching and reordering, never by removing a check.
- **Cite.** Every new row ends with `| espn/12 |` style origin, or `| lesson <slug> |`.
- **Condense.** If a row already covers the item, extend the row; do not add a near
  duplicate. `decisions.md` should stay readable in one sitting.
- **Promote.** An item seen in three builds moves from this skill into the target repo's
  `docs/BUILD_PROTOCOL.md` template under `reference/build-protocol-additions.md`, so new
  repos start with it.
- **Test.** For every new check, write the eval case first, run the check against the
  case, see it fail, then keep it. A check that was never seen failing is not wired.

## Step 4: report

Print `git diff --stat` of the skill directory and a table:

```
| source | destination | one-line summary |
```

followed by the count of items not applied and why. The human sees exactly what the
skill learned. Nothing is committed anywhere. The tracked skill is unchanged until the
human says `promote`.

## Promote (on request only)

`promote` lists every overlay row not yet in the base, the human names the ones to
share (or `all`), the skill copies them into the tracked `reference/` files with origin,
runs `evals/cases.md`, and prepares one commit on `feat/seemly-learnings-<date>` for
the human to push and PR. Corrections are never promoted, only the rules distilled from
them.

## Step 5: the two questions every distill must answer in `corrections/<build>/RETRO.md`

1. **What did the human have to say that the skill should have known?** Each one is a
   row added above; list them.
2. **What did the method get wrong?** Instructions in this skill that produced a false or
   misleading result, stages that were the wrong length, inventories that missed what
   only clicking found. This section must not be empty. It is copied into the corpus
   record's Section 5 for the build.
