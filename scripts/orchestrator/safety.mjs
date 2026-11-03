// What the explorer must not fire on the reference unattended (SKILL.md section 4: paid,
// sending, publishing, deleting or account-changing actions are never fired; the first write
// of each kind is a BLOCKED). Two layers, because either alone has let a write through:
//
//   1. by name: a control whose accessible name or href reads as one of those actions is not
//      clicked at all; it is queued in pending-writes.jsonl for the BLOCKED step.
//   2. by request: while exploring, every non-read request is aborted before it leaves the
//      browser, so a control with an innocent name that writes anyway shows its failure path
//      and is recorded, instead of changing the account.

/** Never clicked, in any mode: ends the session or leaves the account. */
export const NEVER = /\b(log\s*-?\s*out|sign\s*-?\s*out|logoff|delete (my |your )?account|close (my |your )?account|deactivate)\b/i;
const NEVER_HREF = /(log-?out|sign-?out|logoff|\/session\/destroy)/i;

const words = (list) => new RegExp(`\\b(${list.join("|")})\\b`, "i");

/**
 * Money, messages to other people, deletion: not clicked unless the run says `--risky probe`
 * (writes still aborted); otherwise queued for the BLOCKED step.
 */
export const RISKY = words([
  "delete", "remove", "discard", "destroy", "erase", "purge", "revoke", "disconnect", "unlink",
  "cancel (my |your |the )?(subscription|plan|account|order|booking)", "unsubscribe", "downgrade",
  "pay", "payment", "purchase", "buy", "checkout", "place order", "upgrade", "subscribe", "add card", "top up",
  "send", "publish", "invite", "transfer", "withdraw", "book now", "reserve",
  // metered: spends a credit or token the account holds, even when nothing is charged
  "credits?", "tokens?", "spend", "unlock", "redeem",
]);

/**
 * Ordinary form verbs. Clicked, because most of them open the next step (a confirm, a picker,
 * a validation message) and the request layer aborts the write itself, but recorded too so the
 * write path gets its BLOCKED capture.
 */
export const WRITE_VERB = words(["save", "apply", "submit", "confirm", "sync( now)?", "import", "upload", "reset", "restore", "generate", "archive", "share", "post", "push"]);

/** `{ verdict: "never" | "risky" | "write-verb" | "ok", why }` for one probed candidate. */
export function classify({ name = "", href = "" }) {
  if (NEVER.test(name) || (href && NEVER_HREF.test(href))) return { verdict: "never", why: "ends the session or the account" };
  if (RISKY.test(name)) return { verdict: "risky", why: `name reads as money, messaging or deletion: "${name.match(RISKY)[0]}"` };
  if (WRITE_VERB.test(name)) return { verdict: "write-verb", why: `name reads as a write: "${name.match(WRITE_VERB)[0]}"` };
  return { verdict: "ok", why: "" };
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Is this request a write the explorer must abort? GraphQL queries and anything matching the
 * build's `allowPost` patterns (search endpoints that POST a filter) are reads.
 */
export function isWrite({ method, url, postData = "" }, allowPost = []) {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  if (allowPost.some((re) => re.test(url))) return false;
  const body = (postData ?? "").trimStart();
  if (/^\{?\s*"?query"?\s*:?\s*"?\s*(query\b|\{)/.test(body) && !/\bmutation\b/.test(body)) return false;
  return true;
}
