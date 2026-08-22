// Drift: Chaos Mode — tunables and connection details.
//
// The Supabase URL and publishable key are meant to be public: every write goes
// through a SECURITY DEFINER RPC and every read is gated by row-level security
// scoped to room membership. See supabase/migrations/0005_drift_chaos_mode.sql.

export const SUPABASE_URL = 'https://xjfexrlejdkssnwkljet.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_1VfCUi8orTq18RIivwdPQA_OsoDrrsd';

// ── Arena ──────────────────────────────────────────────────────────────────
export const ARENA = Object.freeze({ w: 960, h: 600, wall: 16 });
export const BALL_RADIUS = 11;

// ── Simulation ─────────────────────────────────────────────────────────────
// A fixed timestep is what makes the shared simulation reproducible: given the
// seed and the list of nudges, every client walks the identical tick sequence.
export const DT_MS = 1000 / 60;
export const BALL_SPEED_MIN = 5.5;   // px per tick — keeps the round lively
export const BALL_SPEED_MAX = 13.5;  // px per tick — keeps it playable
export const NUDGE_SPEED = 4.2;      // velocity delta a nudge adds
export const NUDGE_RANGE = 240;      // px; closer clicks push harder

// A nudge is scheduled this many ticks ahead of the clicking player's own
// render tick. Anyone whose network latency beats that applies it without ever
// rewinding; anyone slower rewinds and replays, which stays cheap because a
// whole round is only ~500 ticks.
export const NUDGE_LEAD_TICKS = 9;   // ≈150ms

// ── Netcode ────────────────────────────────────────────────────────────────
export const BROADCAST_HZ = 10;                       // nudge flush cadence
export const BROADCAST_INTERVAL_MS = 1000 / BROADCAST_HZ;
export const NUDGE_REBROADCASTS = 3;  // resends of your own nudge, ~100ms apart

// Backstop poll of the authoritative room state. Broadcast pokes make round
// changes feel instant; this catches a client that missed one, joined late, or
// was backgrounded by the browser.
export const POLL_MS = 1500;

// ── Round flow ─────────────────────────────────────────────────────────────
export const GUESS_WINDOW_MS = 3000;
export const REVEAL_MS = 5200;
export const LEADERBOARD_MS = 6500;
export const COUNTDOWN_LEAD_MS = 2500;  // must match drift_next_round()

// ── Scoring (mirrors drift_publish_truth; the server's numbers are the ones
// that count, these are only for the live preview text) ────────────────────
export const CLOSE_PX = 55;
export const FALLOFF_PX = 400;

export const MAX_PLAYERS = 10;
export const DEFAULT_ROUNDS = 10;
