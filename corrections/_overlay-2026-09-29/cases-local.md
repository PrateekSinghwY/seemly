# Local eval cases

## sorted-table-from-one-dataset (espn-standings-teams-players)
Setup: an API-backed stats table, sortable per column, paged 50 at a time, qualification per stat.
Mistake: capture only the default-sort pages and sort the union locally (228/252 sorted pages wrong).
Expected: capture each column's full order both directions with the page's own params; verify
every captured sorted page's rows and cells against the clone.

Setup: a gate spins up its own Next dev server on a free port to prove the app renders, while the developer keeps `pnpm dev` open.
Mistake: spawn `next dev` with cwd frontend/ — it shares `.next`, rebuilds it, and the developer's tabs throw ChunkLoadError after every commit; misdiagnosed as "stale chunks, touch next.config".
Expected: run the gate's Next from a copy of frontend/ with its own `.next`; prove the developer's `.next/static` mtime is unchanged by a gate run.

Setup: a destination is unserved; one surface (league bar) disables it by ruling, another (pillar hover menu) redirects it to the league home.
Mistake: apply the disabled ruling in one surface's service only; the same link looks live on hover and grey after the click.
Expected: apply the ruling in the shared nav service for every surface carrying the link, and gate parity of disabled state across surfaces.
