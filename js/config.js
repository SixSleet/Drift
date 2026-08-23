// Wordforge — tunables and connection details.
//
// The Supabase URL and publishable key are meant to be public: every write
// goes through a SECURITY DEFINER RPC and every read is gated by row-level
// security scoped to room membership. See supabase/schema.sql.

export const SUPABASE_URL = 'https://ycltdyjtjdrgoyrevepf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_9XEu26xpqmLoP3t41iFZ1w_9lxZu9Vr';

export const MODES = Object.freeze({
  solo: {
    label: 'Solo',
    blurb: 'Just you and the clock. Same rules, no rival — chase your own best score.',
    tint: '#e2a259',
    maxPlayers: 1,
  },
  pvp: {
    label: 'PvP Duel',
    blurb: 'Same word, same start. Fewer guesses wins — you only see your own board.',
    tint: '#cf8465',
    maxPlayers: 2,
  },
  coop: {
    label: 'Co-op',
    blurb: 'One shared board, one shared guess pool. Everyone sees every guess.',
    tint: '#94b073',
    maxPlayers: 10,
  },
});

// ── Round shape ──────────────────────────────────────────────────────────
// Every length the dictionary is seeded for. A room pins one of these before
// it exists (see WORD_LENGTH_CHOICES); `null` keeps the original behaviour of
// re-rolling 4-or-5 each round.
export const WORD_LENGTHS = [4, 5, 6, 7];

// Offered on the title screen, before a lobby is created. Mixed stays 4-5:
// it's the default match, and 6-7 change the feel enough to be a deliberate
// choice rather than something a default should spring on you.
export const WORD_LENGTH_CHOICES = Object.freeze([
  { value: null, label: 'Mixed', hint: '4 or 5, re-rolled every round' },
  { value: 4,    label: '4',     hint: 'Short and sharp' },
  { value: 5,    label: '5',     hint: 'The classic' },
  { value: 6,    label: '6',     hint: 'Getting roomy' },
  { value: 7,    label: '7',     hint: 'Properly hard' },
]);
export const DEFAULT_WORD_LENGTH = null;
export const ROUND_LEAD_MS = 5000;  // matches wf_next_round's starts_at offset —
                                     // long enough to read a full-screen event card
export const ROUND_TIME_MS = 5 * 60 * 1000; // default clock; a round's actual
                                             // round.time_limit_ms is authoritative
                                             // (a blitz event shortens it)

// ── Round-start events ──────────────────────────────────────────────────
// Picked server-side in wf_next_round (35% none, 20% each of three, 5%
// jackpot) — this is display metadata only, any *numeric* effect (blitz's
// clock, jackpot's guess budget) already happened by the time the client
// ever sees the round row. `fx` names the per-event presentation treatment
// in game.js/app.css: 'coins' rains money, 'siren' strobes the flash and
// shakes the screen, 'eclipse' dims the letter legend's hint colours, and
// 'jackpot' stacks all of it. `rule` ('blackout') is read directly by
// game.js to change how a round is actually played, not just how it looks.
export const EVENTS = Object.freeze({
  none: null,
  double_points: { label: 'Double Points', emoji: '💰', tint: '#dfae52', blurb: 'This round pays double.',                                       midBlurb: 'Points doubled, from here on.',      fx: 'coins' },
  blitz:         { label: 'Blitz',         emoji: '⚡', tint: '#d98b5c', blurb: 'Only 90 seconds on the clock.',                                   midBlurb: 'The clock just got cut in half.',    fx: 'siren' },
  blackout:      { label: 'Blackout',      emoji: '🙈', tint: '#9c8f7a', blurb: 'The legend stops showing you which letters you know.',            midBlurb: 'The legend just went dark.',        fx: 'eclipse', rule: 'blackout' },
  jackpot:       { label: 'JACKPOT',       emoji: '🎰', tint: '#dfae52', blurb: 'Extra guess AND double points!',                                  midBlurb: 'Extra guess AND double points!',    fx: 'jackpot', rare: true },
  // Coop-only, and mid-round only -- it needs guesses on the board to swap.
  letter_swap:   { label: 'Letter Swap',   emoji: '🔀', tint: '#cf8465', blurb: 'Two guesses just got their tiles mixed up.',                      midBlurb: 'Two guesses just traded tiles.',    fx: 'siren' },
});

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
