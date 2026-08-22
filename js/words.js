// Client-side dictionary lookup, purely for UX: a "not a real word" shake
// before wasting a keystroke on the network. The server does not enforce
// dictionary membership at all (see supabase/schema.sql / README) — only
// length and alphabetic characters — so this is a courtesy, not a security
// boundary. A modified client could submit anything; it would only ever
// burn that client's own guess (or, in Co-op, the team's shared one).

const cache = new Map(); // length -> Promise<Set<string>>

export function loadDictionary(length) {
  if (!cache.has(length)) {
    cache.set(length, fetch(`data/valid-${length}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`dictionary fetch failed: ${r.status}`);
        return r.json();
      })
      .then((words) => new Set(words))
      .catch(() => new Set())); // offline/blocked: validation just no-ops
  }
  return cache.get(length);
}

/** Best-effort: resolves false only once the dictionary has actually loaded. */
export async function isValidWord(word, length) {
  const set = await loadDictionary(length);
  if (set.size === 0) return true; // dictionary unavailable — don't block play
  return set.has(word.toLowerCase());
}
