// Wordforge — tunables and connection details.
//
// The Supabase URL and publishable key are meant to be public: every write
// goes through a SECURITY DEFINER RPC and every read is gated by row-level
// security scoped to room membership. See supabase/schema.sql.

export const SUPABASE_URL = 'https://ycltdyjtjdrgoyrevepf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_9XEu26xpqmLoP3t41iFZ1w_9lxZu9Vr';

export const MODES = Object.freeze({
  pvp: {
    label: 'PvP Duel',
    blurb: 'Same word, same start. Fewer guesses wins — you only see your own board.',
    tint: '#ff4d9d',
    maxPlayers: 2,
  },
  coop: {
    label: 'Co-op',
    blurb: 'One shared board, one shared guess pool. Everyone sees every guess.',
    tint: '#7be495',
    maxPlayers: 10,
  },
});

// ── Round shape ──────────────────────────────────────────────────────────
export const WORD_LENGTHS = [4, 5, 6, 7];
export const ROUND_LEAD_MS = 3000;  // matches wf_next_round's starts_at offset

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
