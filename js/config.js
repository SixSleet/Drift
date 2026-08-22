// Drift: Chaos Mode — tunables and connection details.
//
// The Supabase URL and publishable key are meant to be public: every write goes
// through a SECURITY DEFINER RPC and every read is gated by row-level security
// scoped to room membership. See supabase/schema.sql.

export const SUPABASE_URL = 'https://ycltdyjtjdrgoyrevepf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_9XEu26xpqmLoP3t41iFZ1w_9lxZu9Vr';

// ── Arena ──────────────────────────────────────────────────────────────────
export const ARENA = Object.freeze({ w: 960, h: 600, wall: 16 });
export const BALL_RADIUS = 11;

// ── Simulation ─────────────────────────────────────────────────────────────
// A fixed timestep is what makes the shared simulation reproducible: given the
// seed and the list of nudges, every client walks the identical tick sequence.
// Rendering interpolates between ticks so the motion is smooth on any refresh
// rate — the physics never sees the fractional part.
export const DT_MS = 1000 / 60;
export const BALL_SPEED_MIN = 5.5;   // px per tick — keeps the round lively
export const BALL_SPEED_MAX = 13.5;  // px per tick — keeps it playable
export const NUDGE_SPEED = 4.2;      // velocity delta a nudge adds
export const NUDGE_RANGE = 240;      // px; closer clicks push harder

// A nudge is scheduled this many ticks ahead of the clicking player's own
// render tick. Anyone whose network latency beats that applies it without ever
// rewinding; anyone slower rewinds and replays, which stays cheap because a
// whole round is only ~500 ticks.
export const NUDGE_LEAD_TICKS = 6;   // ≈100ms

// ── Round modifiers ────────────────────────────────────────────────────────
// Drawn server-side per round and stored on the round row, so a modifier is
// part of the same fixed input as the seed. Every one of them is implemented
// with plain arithmetic — no Math.sin, no wall-clock — so it cannot break the
// determinism the shared simulation depends on.
export const MODIFIERS = Object.freeze({
  none:    { label: 'Standard',       blurb: 'No tricks.',                    tint: '#4bd0ff' },
  gravity: { label: 'Gravity Well',   blurb: 'The centre pulls.',             tint: '#c792ea' },
  turbo:   { label: 'Turbo',          blurb: 'Everything is faster.',         tint: '#ff9f45' },
  drift:   { label: 'Drifting Walls', blurb: 'The obstacles slide.',          tint: '#5eead4' },
  shrink:  { label: 'Closing In',     blurb: 'The arena squeezes shut.',      tint: '#ff4d9d' },
  ghost:   { label: 'Ghost',          blurb: 'The ball blinks out early.',    tint: '#93c5fd' },
});

export const GRAVITY_PULL = 0.055;   // px/tick² toward the centre
export const TURBO_SCALE = 1.45;     // speed clamp multiplier
export const DRIFT_AMPLITUDE = 46;   // px an obstacle slides either way
export const DRIFT_PERIOD = 150;     // ticks for a full there-and-back
export const SHRINK_MAX = 62;        // px the walls creep inward over a round
export const GHOST_ON = 62;          // ticks the ball is visible
export const GHOST_OFF = 26;         // ticks it blinks out

// ── Netcode ────────────────────────────────────────────────────────────────
export const BROADCAST_HZ = 10;                       // nudge flush cadence
export const BROADCAST_INTERVAL_MS = 1000 / BROADCAST_HZ;
export const NUDGE_REBROADCASTS = 3;  // resends of your own nudge, ~100ms apart

// Backstop poll of the authoritative room state. Broadcast pokes make round
// changes feel instant; this catches a client that missed one, joined late, or
// was backgrounded by the browser.
export const POLL_MS = 1500;

// Clocks drift. A round's timing hangs off the server's `starts_at`, so a
// client whose clock has wandered renders the ball where nobody else sees it.
export const CLOCK_RESYNC_MS = 30000;

// ── Round flow ─────────────────────────────────────────────────────────────
export const GUESS_WINDOW_MS = 3000;
export const REVEAL_MS = 5200;
export const LEADERBOARD_MS = 6500;
export const COUNTDOWN_LEAD_MS = 2500;  // must match drift_next_round()

// ── Scoring (mirrors drift_publish_truth; the server's numbers are the ones
// that count, these are only for the live preview text) ────────────────────
export const CLOSE_PX = 55;
export const BULLSEYE_PX = 18;
export const FALLOFF_PX = 400;

export const MAX_PLAYERS = 10;
export const DEFAULT_ROUNDS = 10;
