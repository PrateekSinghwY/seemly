// The single clip-naming definition, shared by the oracle (which writes module clips)
// and scripts/pixel-diff.mjs (which looks them up).
//
// It lives in the repo, not beside the oracle, because pixel-diff.mjs is committed and
// cannot import from the git-excluded discovery folder. When the two carried separate
// copies they drifted, and six modules silently reported NO ORACLE CLIP.
//
// The name derives ONLY from stable identity: column + module title, or the module's
// dom_signature when it has no title. The module's index is deliberately excluded —
// indices shift whenever redaction hides a module, which let stale clips from an
// earlier run sit alongside new ones and still match.
export function clipName(mod) {
  const basis = (mod.title || mod.sig || 'untitled')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'untitled';
  return `${mod.column}__${basis}.png`;
}

// Distinct modules can sanitize to the same name (punctuation-only differences, or a
// shared 48-char prefix), and one clip would then silently stand in for another. The
// name itself is not hashed because the on-disk oracle clips are keyed by it; instead
// every caller that maps a module list to clips rejects a collision outright.
export function assertUniqueClipNames(mods) {
  const seen = new Map();
  for (const m of mods) {
    const name = clipName(m);
    const id = `${m.column}|${m.title || m.sig || ''}`;
    const prev = seen.get(name);
    if (prev !== undefined) {
      throw new Error(`clip name collision: ${name} is shared by "${prev}" and "${id}"`);
    }
    seen.set(name, id);
  }
}
