# Checks

Every gate runs from `./scripts/verify.sh`. `--changed` runs the fast tier; the full
sweep runs everything and is what the pre-push hook calls.

A gate reports through a **check record**, not only its exit code, because a check that
exits 0 having checked nothing has passed three times in one build. The record is
`{ran, count, status, reason, at}` at `discovery/checks/<name>.json`, `<name>` being the
check's name in the table below. `status` is `pass`, `fail` or `skipped`, and a skip is
always `ran: false`. It is written by one helper, `scripts/lib/check-record.mjs`
(`check_record.py` is its Python twin), never by hand-rolled JSON.

Gates that write a record today: `a2_containment` (`check_a2_assets.mjs`),
`components_mounted` (`check_mounted.mjs`), `surface_census_evidence`
(`check_surface_census.py`) and `page_complete` (`check_page_complete.mjs`, which also
keeps its per-route table in `pixel-reports/_page_complete.json`). Any other gate still
reports by exit code alone, and the sweep must treat a check with no record as **not
run**, never as passed. Wiring a gate to the helper is part of adding it.

| check | what it proves | tier | origin |
|---|---|---|---|
| `no_literal_dictionary` | no captured domain string (team, name, headline, label, copy, score) appears in `frontend/` or `backend/` source outside the seed data; allowlist ships empty, every entry needs a committed reason | changed | espn scrape |
| `no_literal_jsx_ast` | AST-based: no JSX text child, template literal without expressions, or literal `title`/`alt`/`aria-label`/`placeholder`/`children` in `.tsx` `.jsx`; regex versions miss multi-line text | changed | lesson #16 |
| `personal_detail_grep` | developer identity from `git config`, email, phone, token patterns: 0 hits across repo and discovery tree | changed | espn/01 |
| `exclusion_single_definition` | every exclusion or redaction selector is imported from one module; grep for inline copies fails | changed | lessons #1 #3 #8 #11 #12 |
| `a2_containment` | no seed row, asset or `ui_copy` came from an excluded module (checked against the captured DOM, not keywords) | changed | lesson assets-unfiltered |
| `components_mounted` | every component in `REGISTRY.md` is imported by the page component or the shell layout | changed | lesson #15 |
| `app_renders` | starts backend and frontend on free ports (never assumes the dev port is free or its own), loads `/` in the persistent profile, asserts measured header height, `tailwindLoaded`, 0 `href="#"` | changed | lessons #14, port-hardcoded |
| `surface_census_evidence` | every negative surface-class verdict cites a probe on every in-scope page | changed | lesson #5 |
| `registry_no_orphans` | one row per archetype, every row has a component, every component has a row | changed | reuse contract |
| `no_league_branch` | grep for `league ===`, `switch (league`, per-page component files; 0 hits | changed | reuse contract |
| `state_schema_current` | `state_schema.json` regenerated and unchanged | full | finding #22 |
| `migration_round_trip` | `alembic downgrade -1 && upgrade head` on a **populated** isolated copy, refuses to run against the working DB, fails on batch residue | full | finding #36 |
| `seed_deterministic` | reset + seed twice, dump, byte-identical | full | RL_BUILD 5A |
| `reset_restores` | delete rows, `POST /reset`, content hash equals baseline | full | slice 1 |
| `deferrals_released` | every deferral row has a release condition; each is re-tested; a released one still deferred fails | changed | lesson deferred-geo |
| `push_guard` | pre-push refuses unless `PUSH_OK=1`; installed via the tool-managed hook config, not a hand edit; and the hook propagates the sweep's exit status | full | finding #35 |
| `page_complete` | per route: pixel-diff every oracle region against the clone in the oracle's own Chrome over CDP (same build, same block list, same A2 redaction), table page × module → differing pixels, fail on any unmasked > 0 or any region without a clone module; refuses, recorded as not-run, if the measured lock is not 1440x900@2 | full | espn/22 |
| `modal_complete` | same per modal and per modal state | full | favorites scope |
| `oracle_coverage` | every pixel of each full-page oracle PNG is inside a listed region or mask, measured as area (`lib/coverage.mjs`), so a missing column is a hole; only gutters and margins of 30 CSS px or less between covered pixels count as covered | full | espn/22 |
| `crosscheck_complete` | every element on every page has structure, style and pixel rows marked ✓ | full | espn/GO |
| `golden_traces` | every trace under `e2e/` replays clean on four channels | full | RL_BUILD 5.9 |

Rules for adding a check (from `SELF_CORRECTION`): every lesson becomes one of these,
or a trace assertion, or a printed checklist row with a written reason why neither was
possible. A check is wired only after it has been seen to fail on the defect it targets.
