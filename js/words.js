// Client-side dictionary lookup, purely for UX: a "not a real word" shake
// before wasting a keystroke on the network. The server does not enforce
// dictionary membership at all (see supabase/schema.sql / README) — only
// length and alphabetic characters — so this is a courtesy, not a security
// boundary. A modified client could submit anything; it would only ever
// burn that client's own guess (or, in Co-op, the team's shared one).
//
// Only the `valid` lists ship (see .github/workflows/pages.yml). The answer
// pools live server-side in wf_words and are deliberately never deployed —
// they are a far smaller set than these, so publishing them would hand
// anyone reading devtools a much shorter list to work from.
//
// Keyed by language as well as by length, because a room is played in one
// language and a guess has to be checked against that language's words:
// "amore" is a word in an Italian room and a typo in an English one.

const cache = new Map(); // `${lang}:${length}` -> Promise<Set<string>>

export function loadDictionary(length, lang = 'en') {
  const key = `${lang}:${length}`;
  if (!cache.has(key)) {
    cache.set(key, fetch(`data/${lang}/valid-${length}.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`dictionary fetch failed: ${r.status}`);
        return r.json();
      })
      .then((words) => new Set(words))
      .catch(() => new Set())); // offline/blocked: validation just no-ops
  }
  return cache.get(key);
}

/** Best-effort: resolves false only once the dictionary has actually loaded. */
export async function isValidWord(word, length, lang = 'en') {
  const set = await loadDictionary(length, lang);
  if (set.size === 0) return true; // dictionary unavailable — don't block play
  return set.has(word.toLowerCase());
}
