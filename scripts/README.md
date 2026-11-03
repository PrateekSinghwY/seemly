# scripts/: working templates from the first build

Two folders are not templates and are never copied into a repo: they run from the skill and
load Playwright from the repo they work on (`lib/pw.mjs`).

- `orchestrator/`: the surface graph engine, the explorer and the build coordinator
  (`run.mjs`; SKILL.md sections 4-5; its own README).
- `qa/`: `edition_gate`, `struct_audit`, `width_sweep`, `human_eye`, `write_roundtrip`, each
  writing its check record (`reference/checks.md`), each proven by eval `X-QA`.

The rest of this file is about the templates.

Every file here ran in a real build (ESPN, Sept 2026) and caught real defects. They are
**templates**: some carry ESPN-specific selectors, route maps and module names that the
skill replaces on first run in a new repo (grep `espn`, `CLONE`, `A2_` and the route
tables). Paths resolve from `RL_REPO` or the current directory; nothing here is absolute.

On the first run in a repo the skill copies `gates/` and `lib/` into the repo's
`scripts/` (tracked), and `capture/` into `never_to_be_pushed/discovery/tools/` (never
tracked), then adapts the site-specific constants and wires `gates/` into
`./scripts/verify.sh` per `reference/checks.md`.

Every tool imports its shared definitions from a `lib/` beside its own folder: gates
use `./lib/` (so `scripts/lib/` once installed), capture tools use `../lib/` (so
`never_to_be_pushed/discovery/lib/`). The install therefore also writes that second
`lib/` as **re-exports only**, one per shared file, so there is still exactly one
definition, in the tracked `scripts/lib/`:

```bash
mkdir -p never_to_be_pushed/discovery/lib
for f in scripts/lib/*.mjs; do
  n=$(basename "$f")
  echo "export * from '../../../scripts/lib/$n';" > "never_to_be_pushed/discovery/lib/$n"
done
```

Re-run it whenever a file is added to `lib/`. Never copy the bodies: a copy is how the
A2 selector drifted.

## gates/ (tracked in the repo, run by verify.sh)

| file | check |
|---|---|
| `check_no_literals.py` | dictionary gate: captured domain strings never in source; empty allowlist |
| `check_jsx_literals.mjs` | AST gate: no JSX text, template or string-prop literals |
| `check_mounted.mjs` | every REGISTRY component imported by the page or shell |
| `check_renders.mjs` | starts the app on free ports, asserts header height, CSS loaded, 0 `href="#"` |
| `check_page_complete.mjs` | per route, per module pixel table; refuses on lock mismatch; writes `ran` |
| `check_a2_assets.mjs` | no seed row or asset from an excluded module |
| `check_surface_census.py` | negative verdicts evidenced on every page |
| `pixel-diff.mjs` | oracle vs clone per module, masks from regions.json, same Chrome build over CDP |

## lib/ (shared, one definition each)

`a2-selector.mjs` (the single exclusion rule: class, id, data attributes, word-level
heading test, keep-list), `clip-name.mjs` (the single clip-naming rule used by oracle
and diff), `block-list.mjs` (the single third-party block list: ads and analytics only),
`snapshot.mjs` (`latestStamp`: every tool reads the newest `raw/<stamp>/`), `lock.mjs`
(the determinism lock, registered for every document a page loads), `a2-redact.mjs`
(the single A2 redaction a live page gets: oracle, pixel-diff and page-complete all call
it), `coverage.mjs` (2-D oracle coverage: every pixel inside a region or a mask),
`check-record.mjs` and `check_record.py` (the `{ran, count, status}` record every gate
writes to `discovery/checks/<name>.json`).

## capture/ (local-only tools)

`preflight.mjs`, `launch-profile.mjs` (headed persistent Playwright profile),
`geocheck.mjs`, `loginstate.mjs`, `capture.mjs` (T0 snapshot: DOM, XHR bodies, globals by
deny-list, text nodes, images, styles), `provenance.mjs`, `normalize.mjs`, `ui-copy.mjs`,
`oracle.mjs` and `oracle-full-clips.mjs` (full-page oracle and clips cropped from it),
`shell-styles.mjs` (computed-style manifest diff, step 8), `trace.mjs`, `poll-probe.mjs`,
`template-diff.mjs`, `grep-personal.mjs`.

Known ESPN-specific spots to generalise on first run: `lib/block-list.mjs`, the
`capture.mjs` page map, `a2-selector.mjs` signals, `pixel-diff.mjs` and `check_page_complete.mjs`
route tables, `check_renders.mjs` header-height assertion, `normalize.mjs` table
mapping.
