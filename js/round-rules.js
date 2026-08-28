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
// is the truth, and nothing here ever edits it. What these functions return
// is what should be SHOWN or what should be ALLOWED; the raw rows are what
// solving, settling and scoring keep using.

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
 * BANNED LETTER: is this guess using the letter that is outlawed this round?
 *
 * The letter comes off the round row, picked server-side from letters that
 * are NOT in the secret -- so this only ever rules out guesses, never the
 * answer.
 *
 * @returns {string|null} a player-facing reason, or null if the guess is legal
 */
export function bannedLetterViolation(word, round) {
  const banned = round?.banned_letter;
  if (!banned) return null;
  const b = String(banned).toLowerCase();
  if (!(word || '').toLowerCase().includes(b)) return null;
  return `${b.toUpperCase()} is banned this round.`;
}

/**
 * SUDDEN DEATH: a guess that scored nothing at all -- not one letter of it
 * anywhere in the word. This is the shape the server settles on too (see
 * wf_check_settle); the client only needs it to stop taking input the
 * instant it happens rather than waiting for the settle round-trip.
 *
 * Deliberately NOT "no hits": openers routinely come back with no greens,
 * and ending on that would kill most rounds on the first guess.
 */
export function isTotalMiss(feedback) {
  return Array.isArray(feedback) && feedback.length > 0
    && feedback.every((f) => f === 'miss');
}

/** Has this player (or, in Coop, the team) already died this round? */
export function suddenDeathOver(guesses) {
  return guesses.some((g) => isTotalMiss(g.feedback));
}

/**
 * FADING INK: which rows have had their colours long enough to lose them.
 *
 * Keyed off the guess's own server timestamp rather than when the client
 * happened to render it, so a player who refreshes mid-round does not get
 * the whole board's colours handed back to them.
 *
 * @param {number} now server-corrected clock, from net.js serverNow()
 * @returns {boolean[]} one flag per guess, true where the colour has gone
 */
export function fadedRows(guesses, now, fadeMs) {
  return guesses.map((g) => {
    const at = Date.parse(g.created_at ?? '');
    if (!Number.isFinite(at)) return false;
    return now - at >= fadeMs;
  });
}
