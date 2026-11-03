
- 2026-09-27 · crest stand-ins keyed by `/500/<abbr>.png` missed `/500/scoreboard/<abbr>.png`, so both
  teams on every Finals card showed the league logo; pixel suites did not cover those cards. Fix:
  CREST_RE + league-logo re-point; gate check_distinct_crests.py.
- 2026-09-27 · two top performers with one stand-in face (one real, one stand-in). Fix:
  budget colours stand-in faces per screen group (cards, games, rosters, players, stats windows).
- 2026-09-27 · scoreboard callout hover filled solid blue (reference: light blue); third button
  missed the Play-By-Play fallback; uncaptured game days were clickable. Measured and fixed.
- 2026-09-27 · meaning-bearing image resolved to a budget stand-in (a followed team's photo key
  rendered another team's player) · caught by the human-eye screenshot, not by any path check ·
  fix: budget class that keeps the rule's candidates genuine.
- 2026-09-27 · a captured card href carried a shortened slug, so an href join to the story table
  silently matched nothing · fix: join on the stable id parsed from the href.
- 2026-09-27 · Tailwind v4 `max-[N]` is exclusive (< N): a "1024 and below" rule written as
  `max-[1024px]` missed exactly 1024 · fix: `max-[1025px]`; verify breakpoints at N-1 / N / N+1.
- 2026-09-27 · unlayered CSS (`.x { display: block }` in globals) beats layered Tailwind
  utilities, so `hidden` on that element did nothing · fix: put the media rule in the same
  stylesheet layer as the rule it overrides.
