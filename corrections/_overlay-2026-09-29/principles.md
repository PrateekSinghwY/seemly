
- **A person's glance outranks the oracle (correction 37).** Stand-ins, budgets and caps must
  never produce something a person reads as wrong: two teams with one crest, two players with one
  face, an enabled control that leads nowhere. Assign stand-ins per screen, not per key; disable
  what is not held; run the human-eye layer (overlay/checks.md) after every built thing.
- **Never claim "all built" while any layer is unrun or failing.** Say what was checked.
- **Edition gate first, every session and every capture (corrections 29-35).** Both tools must
  load the reference host and be served the target edition before anything is captured; report
  the gate's result to the human when a build starts. A VPN is chosen by whether the gate passes
  through it; request geo is reported, the served edition decides.
- **A flow is done only when its whole graph is built and proven (correction 38).** For a
  feature like favorites: every node, every edge from the graph doc, a UI round-trip test
  (write, reload, read on every surface it touches), and the human-eye layer.
- **A known delta that is cheap to fix is a defect, not a gap.** Logging "the tab prints its
  label, not the logo" and moving on shipped a visible fake tab for days. Gaps are for what
  cannot be built (blocked data, ruled-out scope), never for "not done yet".
- **"Is it done?" is answered from a sweep, not from memory.** Before claiming completeness, run
  the structural diff and the multi-viewport probe and report their numbers.
- **Correction numbering is per file**: the standings build has `CORRECTIONS.md` rows 01-22 and `NN.md` files 07-46 whose numbers overlap; cite files as `#NN.md` and table rows as `T#NN`. New builds use `NN.md` files only.
- **Human-eye QA after every built thing** is the human's explicit ruling (#37) and outranks AGENTS.md's "Tier 3 only on request" for this build family: run `qa_human_eye.mjs` per slice, not per edit.

## P-nothing-is-built-until-clicked (2026-09-28, corrections 54-59)
The run reported surfaces as built because their pixels matched at 1440 in the at-rest state. The
reference is an interactive graph; pixels at rest are one state of one node. A module is built only
when every control in it has been fired on both sides, what it opened has been built as a node, and
the page has been compared at every width band. "Matched at rest" is a partial verdict and must be
written as one.
