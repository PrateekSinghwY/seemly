# seemly learning engine

How seemly gets better from build to build, as code instead of growing prose. It sits beside
the orchestrator (`../scripts/orchestrator/`): the orchestrator decides *what to work on*,
this decides *what a worker must remember while doing it*.

## Before and after

| | before (prose only) | now |
|---|---|---|
| where a lesson lives | a row appended to one of `reference/*.md` | one structured row in `lessons.jsonl`, with origin, tags, level, check, eval |
| duplicates | agent judgment | token-overlap dedupe within a phase (`SAME_LESSON` 0.6) |
| "seen 3 times → promote" | counted from memory | `seen[]` per build; `review` lists anything in ≥ 3 distinct builds |
| a rule that did not work | invisible | a recurrence at the lesson's current level flags it for escalation |
| what a worker reads | all of `reference/` (~1,100 lines) | `select` returns ≤ 20 lessons matching the node's phase, kind, area, tool |
| evals | 56 cases run by hand | `cli.mjs evals` runs every executable case; the rest are listed as manual |
| measuring | a scorecard nobody compared | `score trend` flags a metric that got worse than the earlier mean |
| sources | only what the human typed mid-run | also every fix item merged after the build (`mine`) |
| never weaken | a sentence | a lowering lesson is stored `rejected` and `activate` refuses it |

## The ladder

```
prose  ->  checklist  ->  gate  ->  code
(read)     (ticked)       (runs in verify)   (the orchestrator does it)
```

A lesson starts as `prose`. Each time its defect comes back **in a later build, at its
current level**, that level failed, and `review` lists it under `escalate`. Moving to
`gate` or `code` requires the check that now enforces it **and** an eval case proving the
check fails without the fix. Gates and code are not returned by `select`, because they
enforce themselves: the more lessons climb, the less a worker has to read.

## Lifecycle of one lesson

```
correction / verify failure / gate catch / fix commit
        |
        v
record ──> new? ── yes ──> candidate (prose)
        |                      |
        no: seen[] += build     | seen in 3 builds -> review.promote -> activate
        |                      v
        |                  active  ── select() hands it to workers on matching nodes
        |                      |
        +── recurred at this level ──> review.escalate ──> escalate (checklist, gate+check+eval, code)
                               |
                               not seen in 5 builds ──> review.stale ──> retire (with reason)
```

## Files

| file | what |
|---|---|
| `lessons.mjs` | `LessonStore`: record, dedupe, activate, escalate, select, review, retire, merge |
| `mine.mjs` | reads a repo's `fix:` commits, splits each body into fix items, tags areas from the paths each item names |
| `scorecard.mjs` | per-build metrics and trend |
| `evals.mjs` | runs `../evals/runnable.jsonl`; a case with a `bad` fixture must fail there |
| `cli.mjs` | all of the above from the shell |
| `lessons.jsonl` | the shared store (created on first `record`) |
| `scorecard.jsonl` | one row per build |

A build keeps its own inbox store under `never_to_be_pushed/seemly-local/lessons.jsonl`;
`merge --from` folds it into the shared store at `promote`.

## Use

```bash
node cli.mjs record --summary "Every modal traps focus and restores it" --trigger correction \
                    --build espn-2026-10 --phase build --kind modal
node cli.mjs select --phase build --kind modal            # what a worker reads for a modal
node cli.mjs review --builds b1,b2,b3,b4,b5               # promote / escalate / stale
node cli.mjs escalate --id L-1a2b3c4d --to gate --check scripts/gates/check_focus.mjs --eval E57
node cli.mjs mine --repo ../../rl_espn --range main        # fix items as candidate lessons (prints)
node cli.mjs mine --repo ../../rl_espn --range main --record --store <inbox>.jsonl
node cli.mjs evals                                         # exit 1 if any executable case fails
node cli.mjs score add --build espn-2026-10 --corrections 14 --postBuildFixes 78
node cli.mjs score trend
node --test 'test/*.test.mjs'
```

## First real run (2026-10-14)

Mining `rl_espn` `main` found 78 fix items across its squash-merged `fix:` PRs. 32 of them
were tagged with three or fewer areas: the components the item names. The other 46 name
no component, so they carry every area their PR touched. They are stored as candidates,
not rules: distill decides which ones generalise beyond ESPN.

## Not done yet

- The 56 cases in `../evals/cases.md` are still manual; each needs a fixture and a `bad`
  fixture to become executable (`X-ORCH` and `X-LEARN` are the first two runnable cases).
- `reference/*.md` rows have not been imported into `lessons.jsonl`; both exist side by
  side until `promote` moves them.
- The orchestrator does not yet call `select` per node; that lands with step 3.
