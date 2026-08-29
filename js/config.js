// Wordforge — tunables and connection details.
//
// The Supabase URL and publishable key are meant to be public: every write
// goes through a SECURITY DEFINER RPC and every read is gated by row-level
// security scoped to room membership. See supabase/schema.sql.

export const SUPABASE_URL = 'https://ycltdyjtjdrgoyrevepf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_9XEu26xpqmLoP3t41iFZ1w_9lxZu9Vr';

// What a mode IS, not what it is called: names and blurbs live in i18n.js
// under mode.<id> / mode.<id>.blurb, because they change with the language
// and none of this does.
export const MODES = Object.freeze({
  solo: { tint: '#e2a259', maxPlayers: 1 },
  pvp:  { tint: '#cf8465', maxPlayers: 5 },
  coop: { tint: '#94b073', maxPlayers: 10 },
});

// ── Round shape ──────────────────────────────────────────────────────────
// Every length the dictionary is seeded for. A room pins one of these before
// it exists (see WORD_LENGTH_CHOICES); `null` keeps the original behaviour of
// re-rolling 4-or-5 each round.
export const WORD_LENGTHS = [4, 5, 6, 7];

// Offered on the title screen, before a lobby is created. Mixed stays 4-5:
// it's the default match, and 6-7 change the feel enough to be a deliberate
// choice rather than something a default should spring on you.
// `label` is the digit on the chip, the same in every language; Mixed and
// all five hints come from i18n.js (length.<key> / length.<key>.hint).
export const WORD_LENGTH_CHOICES = Object.freeze([
  { value: null, label: 'Mixed' },
  { value: 4,    label: '4' },
  { value: 5,    label: '5' },
  { value: 6,    label: '6' },
  { value: 7,    label: '7' },
]);
export const DEFAULT_WORD_LENGTH = null;
export const ROUND_LEAD_MS = 5000;  // matches wf_next_round's starts_at offset —
                                     // long enough to read a full-screen event card
export const ROUND_TIME_MS = 5 * 60 * 1000; // default clock; a round's actual
                                             // round.time_limit_ms is authoritative
                                             // (a blitz event shortens it)

// ── Round-start events ──────────────────────────────────────────────────
// Picked server-side in wf_next_round (see the odds table right above the
// roll itself, in that function) — this is display metadata only, any
// *numeric* effect (blitz's clock, jackpot's guess budget) already happened
// by the time the client ever sees the round row. `fx` names the per-event
// presentation treatment in game.js/app.css: 'coins' rains money, 'siren'
// strobes the flash and shakes the screen, 'eclipse' dims the letter
// legend's hint colours, and 'jackpot' stacks all of it.
//
// `rule` is the interesting one: it is read directly by game.js and changes
// how the round is actually PLAYED rather than any number attached to it --
//
//   blackout      the legend stops tracking what you have ruled out
//   cipher        feedback loses its positions -- counts only, Mastermind-style
//   lockdown      a guess is illegal unless it reuses every confirmed letter
//   fading_ink    colours fade off each row seconds after it lands
//   banned_letter one letter is outlawed for the whole round
//   sudden_death  a guess that scores nothing at all ends the round
//   wager         stake points on solving it, before the round starts
//
// The first five are client-side, exactly like blackout always was: the
// feedback stored server-side is always the truth (see wf_score_guess), so
// none of them can change who solved a round or what it paid. The last two
// have to be server-side as well, because they decide when a round ends and
// what it pays -- see wf_check_settle and wf_place_wager. What is here for
// those two is the presentation and the input rules only.
// Emoji, tint, fx and rule -- everything about an event that is not words.
// Its name, its card text and its mid-round line are keyed by the same
// event name in i18n.js (event.<name>.label / .blurb / .mid), because those
// change with the reader's language and none of this does.
export const EVENTS = Object.freeze({
  none: null,
  double_points: { emoji: '💰', tint: '#dfae52', fx: 'coins' },
  blitz:         { emoji: '⚡', tint: '#d98b5c', fx: 'siren' },
  blackout:      { emoji: '🙈', tint: '#9c8f7a', fx: 'eclipse', rule: 'blackout' },
  jackpot:       { emoji: '🎰', tint: '#dfae52', fx: 'jackpot', rare: true },
  // Coop-only, and mid-round only -- it needs guesses on the board to swap.
  letter_swap:   { emoji: '🔀', tint: '#cf8465', fx: 'siren' },
  // Round-start only: wf_next_round's mid-round pool never contains these,
  // the same way it never contains jackpot. They rewrite the rules of the
  // round, which is not something to spring on someone halfway through it.
  cipher:        { emoji: '🔢', tint: '#7f9bb5', fx: 'eclipse', rule: 'cipher', rare: true },
  lockdown:      { emoji: '🔒', tint: '#c2705a', fx: 'siren', rule: 'lockdown' },
  sudden_death:  { emoji: '🩸', tint: '#cc5544', fx: 'siren', rule: 'sudden_death', rare: true },
  fading_ink:    { emoji: '🫥', tint: '#8fa9a0', fx: 'eclipse', rule: 'fading_ink' },
  banned_letter: { emoji: '🚫', tint: '#c2705a', fx: 'siren', rule: 'banned_letter' },
  wager:         { emoji: '🎲', tint: '#dfae52', fx: 'coins', rule: 'wager', rare: true },
});

// How long a row keeps its colours under FADING INK before they drain away.
// Long enough to read the row properly and take it in; short enough that you
// cannot use the board as a notepad, which is the entire modifier.
export const FADE_INK_MS = 8000;

// The stakes offered on a WAGER round. Mirrored in wf_place_wager, which
// rejects anything not in this set -- keep the two in step.
export const WAGER_STAKES = [25, 50, 100];

// ── Mid-round modifiers ──────────────────────────────────────────────────
// A second, independent global roll made at mint time (wf_next_round: 55%
// nothing, the rest split across whatever the round did NOT already open
// with; letter_swap coop-only). Applied partway through live play once the
// round's clock crosses `mid_modifier_at_ms`, via wf_apply_mid_modifier /
// wf_trigger_letter_swap. Unlike room events these are global and shared:
// everyone in the room gets the same one at the same moment.
//
// Room events -- the cat, the moth, the phone, the lamp, the rain -- are the
// opposite: rolled per client in room-events.js, seen only by that player,
// and they mutate no game state at all.

export const TICK_START_MS = 10000; // audible tick begins this far from zero
export const EVENT_CARD_MS = 5000;  // full-screen event card, minimum readable time

// ── Scoring preview (server's numbers in wf_check_settle are authoritative;
// these are only for in-flight UI hints) ────────────────────────────────
export const FAST_BONUS_FACTOR = 4;   // elapsed <= length * this(s) -> +20
export const OK_BONUS_FACTOR = 7;     // elapsed <= length * this(s) -> +10

// ── Flow timing ──────────────────────────────────────────────────────────
export const REVEAL_MS = 4500;
export const BOARD_MS = 5500;
export const SETTLE_RETRY_MS = 1200; // how often a stalled round retries settle

// ── Netcode ────────────────────────────────────────────────────────────────
export const POLL_MS = 1500;          // wf_state backstop poll
export const CLOCK_RESYNC_MS = 30000;

export const MAX_PLAYERS = 10;
export const DEFAULT_ROUNDS = 6;
export const ROUNDS_CHOICES = [4, 6, 8, 12];

// Letter tier ranking, used to pick the "best known" colour for a keyboard key.
export const TIER_RANK = Object.freeze({ miss: 0, present: 1, hit: 2 });
