// The rule-changing round modifiers, as pure functions.
//
// Four of the round-start events (see EVENTS in config.js) do not move a
// number -- they change how the round is played. Everything they need is in
// here, deliberately free of DOM and of game state, because that makes each
// one a plain input/output function that can be reasoned about and tested on
// its own. game.js decides *when* to call them; this file decides what they
// do.
//
// The load-bearing rule for the whole file: the feedback the server stored
// is the truth, and nothing here ever edits it. `deceit` and `cipher` build
// a separate DISPLAY copy, and the raw rows are what solving, settling and
// scoring keep using. A lie can make you waste a guess; it can never take a
// round you actually won.

/** Tiers in the order wf_score_guess produces them. */
const TIERS = ['hit', 'present', 'miss'];

/**
 * FNV-1a. Any stable string->int would do; what matters is that it is
 * deterministic, because the lie for a given row has to be the SAME lie on
 * every re-render. Deriving it from Math.random() would mean the board
 * changed its story every time the render loop ran, which reads as a broken
 * game rather than a dishonest one.
 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * DECEIT: corrupt exactly one tier in a row of feedback.
 *
 * Two rows are never touched:
 *   - a solved row (every tile a hit), because a player who has won must be
 *     told they have won;
 *   - a row where the lie would *manufacture* a win -- if every other tile
 *     is already a hit, flipping the last one to 'hit' would show a solve
 *     that did not happen, so it lies the other way instead.
 *
 * @param {string[]} feedback raw, server-truth tiers for one guess
 * @param {string} key stable identity for this row, e.g. `${roundId}:${attempt}`
 * @returns {string[]} a new array; the input is never mutated
 */
export function lieAboutRow(feedback, key) {
  if (!Array.isArray(feedback) || feedback.length === 0) return feedback;
  if (feedback.every((f) => f === 'hit')) return feedback.slice();

  const h = hash32(key);
  const idx = h % feedback.length;
  const truth = feedback[idx];
  let options = TIERS.filter((t) => t !== truth);

  // Would this lie invent a solve? Only possible when everything else is
  // already a hit. Drop 'hit' from the options in that case.
  const restAllHit = feedback.every((f, i) => i === idx || f === 'hit');
  if (restAllHit) options = options.filter((t) => t !== 'hit');
  if (options.length === 0) return feedback.slice();

  const out = feedback.slice();
  out[idx] = options[(h >>> 8) % options.length];
  return out;
}

/**
 * Applies DECEIT across a whole board. Returns display copies, leaving the
 * caller's rows untouched so the real feedback stays available for solve
 * detection.
 */
export function applyDeceit(guesses, roundId) {
  return guesses.map((g) => ({
    ...g,
    feedback: lieAboutRow(g.feedback, `${roundId}:${g.player_id}:${g.attempt_no}`),
  }));
}

/**
 * CIPHER: how many hits and presents a row scored, with no indication of
 * where any of them are. This is the whole modifier -- the tiles render
 * blank and you get these two numbers, so working out the positions is on
 * you. The counts themselves are honest.
 */
export function cipherCounts(feedback) {
  let hits = 0;
  let presents = 0;
  for (const f of feedback) {
    if (f === 'hit') hits++;
    else if (f === 'present') presents++;
  }
  return { hits, presents };
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'];

/**
 * Everything the board has confirmed so far: which positions are pinned to a
 * known letter, and which letters are known to be in the word somewhere.
 *
 * Reads RAW feedback -- lockdown and deceit are different events and never
 * run in the same round, so there is no lying board to defend against here.
 */
export function confirmedLetters(guesses) {
  const greens = new Map();   // index -> letter (lowercase)
  const presents = new Set(); // letter (lowercase)
  for (const g of guesses) {
    const word = (g.word || '').toLowerCase();
    g.feedback.forEach((tier, i) => {
      if (tier === 'hit') greens.set(i, word[i]);
      else if (tier === 'present') presents.add(word[i]);
    });
  }
  // A letter pinned to a position no longer needs to be argued about
  // separately -- requiring it twice would reject a legal guess that uses it
  // exactly once, in the place we already know it goes.
  for (const letter of greens.values()) presents.delete(letter);
  return { greens, presents };
}

/**
 * LOCKDOWN: a guess is only legal if it keeps every letter the board has
 * already confirmed -- greens stay where they were found, and every known
 * present letter appears somewhere. (This is the "hard mode" a lot of word
 * games offer as an option; here it arrives unannounced and is compulsory.)
 *
 * @returns {string|null} a player-facing reason, or null if the guess is legal
 */
export function lockdownViolation(word, guesses) {
  const w = (word || '').toLowerCase();
  const { greens, presents } = confirmedLetters(guesses);

  for (const [i, letter] of greens) {
    if (w[i] !== letter) {
      return `Lockdown: the ${ORDINALS[i] ?? `${i + 1}th`} letter has to be ${letter.toUpperCase()}.`;
    }
  }
  for (const letter of presents) {
    if (!w.includes(letter)) {
      return `Lockdown: your guess has to use ${letter.toUpperCase()}.`;
    }
  }
  return null;
}

/**
 * HEAD START: the one letter the server handed out at mint time, as a
 * display string. The letter and its position live on the round row
 * (hint_index / hint_letter, set in wf_next_round) because picking them
 * requires reading the secret, which only the server may do.
 */
export function headStartLabel(round) {
  if (!round || round.hint_index == null || !round.hint_letter) return null;
  const ord = ORDINALS[round.hint_index] ?? `${round.hint_index + 1}th`;
  return `${ord} letter is ${String(round.hint_letter).toUpperCase()}`;
}
