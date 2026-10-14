# SELF_CORRECTION.md: how the agent learns from its own mistakes inside one build

Generic method, not ESPN-specific. Lives in `never_to_be_pushed/`. Every build prompt
that references it (`ESPN_BUILD.prompt.md` does) runs it as written.

`BUILD_PROTOCOL.md` is what the repo learned from **past** builds. `RL_BUILD` Part 8 is
what **this** build teaches the corpus at the very end. Neither one makes slice 6
cheaper than slice 2. This file does. It closes the loop mid-run: every failure becomes
a rule, every rule becomes a check, every check runs before the next slice starts.

---

## The one rule

**A lesson that is not a check is a note, and notes do not count.**

When something goes wrong, you may not just fix it and move on, and you may not just
write "be careful about X" somewhere. You turn it into one of exactly three things:

| tier | what it is | when to use it |
|---|---|---|
| **T1 mechanical** | a grep, a lint rule, a unit test, a line in `verify.sh --changed` | the mistake is detectable in source. Always preferred. |
| **T2 trace** | an assertion in a golden trace under `e2e/` | the mistake is detectable only at runtime, in a click sequence |
| **T3 checklist** | a row in `LESSONS.md` that the pre-slice block prints and you tick | the mistake is a judgment call no machine can catch. Last resort, and each T3 needs a one-line reason why T1 and T2 were impossible. |

If you find yourself writing a T3 for something a grep could catch, that is the
mistake, and the lesson is "make it T1."

---

## The ledger: `never_to_be_pushed/discovery/LESSONS.md`

Created at the start of the build, empty. One row per lesson, appended, never edited
after the fact except to change `status`.

```
| # | slice.step | what went wrong (observable) | root cause | catalogue class or NEW | the rule | check (T1/T2/T3 + where) | siblings grepped | rounds cost | status |
```

- **what went wrong**: the observation, not the interpretation. "Nav dropdown closed on
  moving to the adjacent tab; reference keeps it open." Not "hover logic was wrong."
- **root cause**: why the method allowed it. "Fired the hover with forced `:hover` only;
  behaviour needs a real mouse move" is a root cause. "Bug" is not.
- **catalogue class**: the matching row in `BUILD_PROTOCOL.md`'s Defect Catalogue, or
  `NEW`. Three `NEW`s with the same shape are a missing catalogue row; see Promotion.
- **siblings grepped**: what you searched for, how many you found, all fixed in the
  same change. `BUILD_PROTOCOL` already says "fix the class, not the instance." This
  column is the proof.
- **rounds cost**: how many step-8 convergence rounds or step-9 verify failures it
  consumed. This is what lets you see if you are getting faster.
- **status**: `OPEN` (check not yet wired), `WIRED` (check exists and ran green once),
  `PROMOTED` (moved into `BUILD_PROTOCOL` or the corpus).

---

## When a row is written: the six triggers

Any one of these fires the ledger. No exceptions, no "too small to record."

1. **Step 9 verify fails** on any channel, for any reason, on any slice.
2. **Step 8 takes more than 5 convergence rounds.** Five is RL_BUILD's stated upper
   expectation; exceeding it means something systematic, not something pixel-level.
3. **A gate check catches something** (`check_no_literals`, the reuse-contract check,
   the logged-out assertion, the personal-detail grep). The gate did its job; the
   lesson is why the mistake got as far as the gate.
4. **The human corrects you.** Anything at a gate, any `NOTE:`, any "no, the reference
   does X." Every human correction is a row, written before you reply, and the reply
   names the row number.
5. **An `ASSUMPTIONS.md` row turns out wrong.** The assumption was the mistake; the
   lesson is what evidence would have prevented it.
6. **You catch yourself.** You were about to invent a control, type a string, branch
   on a league key, or build before the capture landed, and stopped. Near-misses are
   the cheapest lessons there are. Record them.

---

## Pre-slice block: printed before any slice starts

```
SLICE <n> <name>
LESSONS      <n> rows, <n> WIRED, <n> OPEN
  OPEN → cannot start. Wire them first, or explain in one line why the slice
         cannot trigger that lesson and mark it N/A for this slice.
CHECKS RUN   T1: <list, each ✓>   T2: <traces re-run, ✓>   T3: <ticked rows, by #>
CATALOGUE    read against this slice's plan: <n> rows relevant, none violated by design
PREDICTED    rounds to converge: <n>   (from the last slice of the same archetype class)
```

`OPEN` lessons block the slice. That is the whole point: a lesson you learned in
slice 2 is enforced before slice 3 starts, not remembered halfway through slice 5.

---

## Post-slice block: printed before a slice is declared done

```
SLICE <n> DONE
ROUNDS       predicted <n>, actual <n>          ← faster, same, or slower than predicted
NEW LESSONS  <n>  (#a, #b, ...)  all WIRED ✓ | <which are OPEN and why>
SIBLINGS     <n> found across <n> files, all fixed in this change
REGRESSION   <none | slice n+1 of this class was slower than slice n: investigate before continuing>
FRESH-EYES   reviewer verdict: <clean | <n> findings, all addressed>
```

Then the `BUILD_PROTOCOL` "before declaring done" block as usual.

**The regression rule.** If a slice of the same archetype class as an earlier one
takes **more** rounds than that earlier one, stop before the next slice and write a
lesson about why. The trend line across slices must go down or stay flat. A rising
trend is the method failing and is more important than the slice.

---

## Fresh-eyes review: the check you cannot run on yourself

Before declaring any slice done, spawn a reviewer subagent with **no build context**:
one worktree, read-only, and only these inputs: the capture for this slice (frames,
computed styles, AX tree), the diff, `BUILD_PROTOCOL.md`, and `LESSONS.md`. Its
instruction is fixed:

> Compare this diff to this capture. List every place they disagree, every Defect
> Catalogue row this diff violates, every LESSONS row it repeats, and every control
> with no handler that is not genuinely disabled. Do not suggest improvements to the
> reference. Do not fix anything. Report only.

You built it, so you will read your own intent into it. The reviewer has no intent to
read. Every finding it returns is either fixed in the same change or refuted in one
line in the post-slice block. Refuting more than a third of a reviewer's findings on
one slice is itself a lesson: your review prompt or your capture is unclear.

---

## Promotion: when a lesson leaves the ledger

- **Seen twice in this build** (same catalogue class, or two `NEW` rows with the same
  shape): the T1 check moves from `verify.sh --changed` into the always-run tier so
  it cannot be skipped by a narrow change set.
- **Seen three times, or `NEW` and structural**: a row in `BUILD_PROTOCOL.md`'s Defect
  Catalogue, in the same change, with this build's commit hash as the evidence. The
  catalogue is a living file; that is what "the corrections become a procedure the
  agent runs itself" means.
- **Anything about the method** (an RL_BUILD instruction that produced a false result,
  a stage that was the wrong length, an inventory that missed what only clicking
  found): the row is copied verbatim into RL_BUILD Part 8, Section 5 of the corpus
  record, at the end. The corpus section must not be empty; the ledger is where its
  content comes from.

---

## Anti-patterns: ways of "learning" that are actually forgetting

| never | because |
|---|---|
| Add an allowlist entry to make a check pass | that is the check learning to ignore the mistake. An allowlist entry needs a committed one-line reason and is itself a ledger row. |
| Weaken a check so the slice can ship | a lowered bar is silent scope narrowing. Scaling down is the human's call, at a gate. |
| Write the lesson as a general virtue ("be more careful with hover states") | unenforceable. Write the observable, the root cause, and the check. |
| Fix the instance and mark it WIRED without a sibling grep | the second instance is the one that costs the most, because you already believed it was fixed. |
| Record lessons in chat only | chat is gone next session. The ledger is a file, and it is read at the start of every session. |
| Skip the fresh-eyes review because the slice was small | small slices are where "painted but dead" ships. The reviewer is cheap. |
| Let the ledger grow without promoting | fifty T3 rows is a checklist nobody reads. Promote to T1 or to the catalogue, and collapse. |

---

## Resuming a build in a new session

Sessions end. Context is lost. The ledger and two more files make the next session
start where this one stopped, instead of re-learning:

- `never_to_be_pushed/discovery/LESSONS.md`: read first, every session, before
  anything else in the build prompt.
- `never_to_be_pushed/discovery/RESUME.md`: written after every slice and after every
  gate. Exactly: current slice and step, queue position, last green check run, open
  lessons, the next three actions. Overwritten each time, never appended.
- `never_to_be_pushed/discovery/NOTES.md`: RL_BUILD's mid-run human notes. Unaddressed
  ones are printed at the top of the resumed session, before the pre-slice block.

A new session that starts building without printing "RESUMED FROM: slice n, step m,
<n> lessons loaded, <n> open" has skipped this file.
