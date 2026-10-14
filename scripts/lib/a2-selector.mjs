// The single A2 exclusion definition. EVERY consumer imports this — capture, normalise,
// the pixel oracle, pixel-diff and check_a2_assets.
//
// It has drifted three times (LESSONS #1, #3, #8, #10). Each time a consumer carried its
// own copy that was missing one signal, and each time a personal or account-bound surface
// escaped through the gap: a fantasy team name into a provenance sample, the Fantasy rail
// into a screenshot, #favfeed-footer into a pixel baseline, and fantasy-rail images into
// the committed seed. Do not inline this list. Extend it here.
export const A2_SELECTOR = [
  // class signals
  '[class*=favItem]', '[class*=fantasySignup]', '[class*=favorite]', '[class*=Favorite]',
  '[class*=fantasy]', '[class*=Fantasy]', '[class*=forYou]', '[class*=ForYou]',
  '[class*=avatar]', '[class*=Avatar]', '[class*=accountMenu]', '[class*=AccountMenu]',
  '[class*=userProfile]', '[class*=UserProfile]', '.user-profile', '[class*=sideLogin]',
  // id signals. NOT a loose `fav` substring: `#favfeed-footer` is ESPN's LEGAL FOOTER
  // (Terms of Use, Privacy Policy, Your US State Privacy Rights) and a substring match
  // excluded the whole thing — the sixth instance of this rule matching at the wrong
  // granularity. Match the word, not a fragment of it.
  '[id*=favorite]', '[id*=Favorite]', '[id*=fantasy]', '[id*=Fantasy]',
  '[id*=foryou]', '[id*=ForYou]',
  '#global-user-trigger', '#global-header li.user',
  // data-attribute signals
  '[data-league-id]', '[data-team-id]', '[data-user-id]',
].join(',');

// Heading-text signal: the Fantasy rail's class is plain `sub-module quicklinks`, so a
// class/id test alone cannot see it.
//
// SCOPE MATTERS. This applies ONLY to rail/module containers. It must never be applied
// to a feed item: an article headlined "ESPN Fantasy Football Hall of Fame enshrines..."
// is published editorial content, and matching it dropped real articles and their images
// out of the seed. A module heading names a module; an article headline is data.
export const A2_HEADING_SOURCE = '^(favorit|fantasy|for you|my teams)';

// The only containers the heading signal may be tested against.
export const A2_HEADING_SCOPE = '.sub-module, .module, aside, [class*=rail]';

// Never treat a feed item as a module, whatever its headline says.
export const A2_HEADING_NEVER = '.contentItem, .contentFeed, #news-feed, [class*=contentItem]';

// Containers whose name trips a signal but whose CONTENT is public chrome. Each needs a
// one-line reason, like the no-literal allowlist. This is not an escape hatch for a
// module that really is account-bound.
export const A2_KEEP = [
  // ESPN's legal footer: Terms of Use, Privacy Policy, state privacy rights, contact.
  // Named "favfeed-footer" by the reference; holds no account data.
  '#favfeed-footer',
].join(',');

// Account-scoped query parameters on a nav href.
export const A2_PERSONAL_QUERY_SOURCE = '[?&](leagueId|teamId|seasonId|entryId)=';
