# INTAKE: how to tell seemly what to build

## The short way: a URL, and anything else you feel like adding

```
seemly https://www.espn.com/nba/scoreboard
```

That is a complete request. Full power applies by default: everything on the page,
everything reachable from it under its path prefix, every state, every flow, backend,
database, seed, reset, three-way cross-check, self-correction, no questions after the
first block.

Add whatever you have, in any form, in the same message: screenshots of states it might
not reach, a recording, a sentence about what matters ("the date picker is the point"),
what you know is broken on the reference, a component name, a time budget, a login note.
Seemly reads all of it as `GIVEN`, folds it into the inferred block below, and treats
screenshots as the shot list (never as the styling source; the live DOM is). Nothing you
attach is required, and nothing you leave out is asked for.

Seemly opens the page in Chrome for two to three minutes, looks at what is on it and what
leads away from it, and prints **one** block with every field filled in, its guesses
marked `[inferred]` and everything else `[default]`:

```
INTAKE, inferred from the page. Reply "go", or correct any line.
  TARGET    https://www.espn.com/nba/scoreboard
  SCOPE     PAGE nba scoreboard                       [inferred: one route, 14 modules, 3 pickers]
  DEPTH     all under /nba/                           [default] reachable: /nba/game/* (16), /nba/team/* (30), /nba/scoreboard?date=* (any); external (4) stay links
  REACH     direct, page at rest + today's date       [inferred] other states seen: date picker (any date), league picker
  LOGIN     none                                      [inferred: logged-out view renders fully]
  EDITION   US (en-us)                                [inferred from Chrome]
  NEVER     anything that pays, sends, deletes, changes account settings   [default] seen on page: "Bet" links (external)
  FIDELITY  MAXIMUM                                   [default]
  BUDGET    run to DONE                               [default]
```

You reply `go`, or something like `DEPTH 1 under /nba/game/, REACH date Wed May 13,
BUDGET 8h`. That is the only question seemly ever asks. After `go` it runs unattended.

## The long way: fill the fields yourself

One message. Two fields are required; everything else has a default from
`reference/decisions.md` and is only worth typing when the default is wrong. The skill
never asks for anything on this list; if it is missing, the default applies and an
`ASSUMPTIONS.md` row records it.

```
seemly
TARGET:    <one or more URLs, or "the whole app at <url>">          [required]
SCOPE:     APP | FEATURE <name> | PAGE <name>                          [required]
DEPTH:     all under <url prefix> | 1 under <prefix> | 0                  [default: all under the target's own path prefix]
REACH:     <clicks from the landing page, or "direct URL">; name any state to
           capture (a date, a filter, a tab) as part of the reach              [default: direct, page at rest]
LOGIN:     none | I will log in once by hand | roles: <a>, <b>         [default: none]
EDITION:   <country / language edition if the site geo-routes>        [default: what my browser shows]
GIVEN:     <recordings, HAR, screenshots of states I cannot reach>    [default: nothing]
KNOWN:     <already built, deliberately disabled, known broken>       [default: read the repo]
NEVER:     <paid, metered, sending, deleting actions>                 [default: NEVER FIRE anything that pays, sends, publishes, deletes, or changes account settings]
FIDELITY:  MAXIMUM | HIGH | FUNCTIONAL                                 [default: MAXIMUM]
BUDGET:    <hours; QA passes continue until spent>                     [default: run to DONE]
DONE:      <in your words, if different from the skill's>             [default: SKILL.md section 10]
```

Example, minimal:

```
seemly
TARGET: https://app.example.com/dashboard
SCOPE:  APP
LOGIN:  I will log in once by hand
NEVER:  "Send report" costs a credit
BUDGET: 8h
```

## What DEPTH means

The default is **everything reachable**. Give a URL and seemly builds the page, every
control and state on it, and then follows every internal link under the URL's own path
prefix (`/nba/scoreboard` → everything under `/nba/`), builds that page and everything
on it, follows its links, and so on, one branch at a time, until no unvisited node
remains. Redirects are followed and recorded as edges. A root URL (`example.com/`) means
the whole same-origin site.

- `DEPTH: all under <prefix>` (default, prefix inferred from the URL): follow every
  internal link under the prefix until the graph closes. Links outside the prefix and
  external links stay real `<a href>` to the standard out-of-scope page with a GAP row.
- `DEPTH: 1 under <prefix>`: only pages one click away.
- `DEPTH: 0`: only the page and what opens on it.

The graph makes this tractable: pages sharing a DOM skeleton are one template, built
once; every further page of that template is configuration rows. A site with 300 game
pages has one game-page template. Priority is shell first, then the templates with the
most incoming links, then breadth-first from your URL, so the first page lands early and
the long tail is mostly configuration.

A state named in REACH (a date, a tab, a filter) is a state of the page captured at T0,
not a different T0. T0 is always the instant of capture.

## What to share, and what not to

| share | why |
|---|---|
| The URL(s) | the only thing the skill cannot derive |
| A login done by hand in the window it opens | never paste credentials; never let it script a login |
| Screenshots or recordings **only** for states it cannot reach: a paid tier, a populated list when your account is empty, an error state, a role you have but it has no login for | it reads the live DOM far better than a PNG; do not send screenshots of screens it can open |
| The edition or country, if the site geo-routes and your browser has a VPN | both tools must reach the same edition; it checks at preflight |
| Anything that costs money or spends a credit | goes on the NEVER list; it will not discover this safely on its own |
| A time budget, if you want QA passes | otherwise it stops at DONE |

Do not share: file dumps of the site, hand-written specs of how the UI "should" look,
API docs (the capture outranks docs), or your own component sketches. The reference is
the spec.

## What happens after you send it

1. Preflight, ten minutes, printed once. Loads the target in both browsers, prints
   edition, login state, tool health, repo state, first-page deadline. A ✗ prints the
   one fix and stops. Otherwise you hear nothing.
2. Snapshot at T0, click tree, build, verify, as in `SKILL.md`. Progress goes to
   `never_to_be_pushed/discovery/RESUME.md`. Look at `localhost:3000` any time.
3. You may hear from it for exactly three reasons: `BLOCKED` (something only you can
   do, stated in one line; reply `resume`), `SESSION CHECKPOINT` (context full; open a
   fresh session and send `seemly resume`), `DONE` (the scorecard and the report).
4. `STATUS` at any time returns six lines. `NOTE: ...` corrects it mid-run and is saved
   as a correction. `STOP` halts cleanly.
5. After `DONE`, `distill` teaches it. Read the printed diff; that is what it learned.

## Resuming

```
seemly resume
```

It reads `LESSONS.md`, then `RESUME.md`, prints `RESUMED FROM: <phase>.<step>`, and
continues. Nothing to re-explain.
