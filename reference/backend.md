# Backend, database, schema and network: how the clone's data layer is built

The full method is `method/RL_BUILD.prompt.md` Part 5 steps 4 to 7 and Part 5A, and the
target repo's `AGENTS.md` wins on stack. This file is the compressed contract the skill
enforces on every build.

## Schema comes from payloads, never from memory

- Step 4 of the loop harvests every request and response body and the client store
  delta. Step 5 induces, per endpoint: request and response JSON Schema, status codes and
  error shapes, **id format** (integer, uuid, nanoid, prefixed, numeric-string), **ordering
  strategy** (integer position, fractional index, array position), timestamp format and
  timezone, pagination shape, invariants.
- For server-rendered pages the hydrated DOM is a payload too: nav trees, footers, strips,
  module composition are induced from it with provenance `html-hydrated`.
- Id formats and ordering are matched exactly. A wrong id format leaks a learnable
  pattern to the agent being trained.
- Check `docs/MCP_SCHEMA_REFERENCE.md` conflicts before defining any shape; grep for an
  existing near-miss table before creating one. The parallel near-miss table is the
  number one schema defect.

## Tables the clone always has

`page`, `page_module` (page × module × order × scope × params), `nav_menu` / `nav_item`
(label, href, order, parent, group, classification, is_current), `ui_copy` (every
bundle string the reference renders, keyed by module and page), `asset` (hash, original
path, size, kind, entity ref), plus every domain entity the payloads force. Every column
a surface reads is written by something; every collected field round-trips.

## Backend shape (per AGENTS.md; these are the invariants)

- Pydantic request and response models first, then the TS interface mirroring them.
- Thin router, service layer, one transaction per mutation.
- Full OpenAPI metadata: tags, summaries, descriptions, error models, examples that are
  **illustrative, never captured strings** (the no-literal gate scans schemas too).
- One migration per module, linear chain, never edited after commit; `downgrade()`
  works and is round-tripped on a populated copy.
- Index every FK and every filtered or sorted column.
- Environment endpoints ship with the first migration: `POST /reset`, snapshot and
  restore, state introspection (rewards read rows, never the DOM).

## Network mirroring

- Every reference request the page consumed is mirrored under `/api` relative, same
  shapes, same ids, same pagination (`offset`/`limit`/`has_more` as observed, capped at
  the captured depth, never at the reference's advertised total).
- Polling or realtime is frozen at T0: the refresh endpoint exists, is called at the
  observed interval, and returns the same seeded rows.
- If the reference's rendering model makes 1:1 mirroring impossible (server components
  on their side, SWR on yours), the deviation is written to `docs/DOMAIN_NOTES.md` in the
  same change. Never invent an endpoint shape to fill a gap.
- Frontend fetches only through the repo's `fetcher` / `mutationFetcher`, every query
  param in the key, revalidation fan-out enumerated per mutation.

## Seed and determinism

- Tier 1 source only while the reference is reachable: captured payloads and the
  hydrated DOM. No synthesis, no fixtures on a production path, no canned fallback.
- Seeded RNG, frozen clock at T0, stable ids in the reference's format, through the
  service layer, `pnpm reset && pnpm seed` twice byte-identical, reset idempotent,
  snapshot restores byte-identically, state contract regenerated (never hand-edited).
- Baseline seed vs scenario seeds kept separate; a baseline change is its own reviewed
  change.
- Row-count parity: for every `page_module`, the count the reference rendered equals the
  seed count equals the endpoint count. Printed as a table at verify.

## Write paths (when the scope has any)

W1 scope by id · W2 every field persisted and read back · W3 edit seeds from the whole
record fetched fresh · W4 survives reload and backend restart · W5 revalidation fan-out
enumerated (list, detail, counters, parents) · W6 errors as the reference renders them.
One golden trace per write: perform, reload, assert; restart backend, assert; reset,
assert baseline.

## Persistence proof, in order, before any UI

1. Write, reload, value survives. 2. Write, restart backend, survives. 3. `POST /reset`
returns to seed; snapshot taken before the write restores byte-identically; reset twice
is idempotent.
