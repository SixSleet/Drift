// Supabase plumbing: the player token, clock sync, RPC wrappers, and the
// realtime channel that carries live guesses and PvP ghost progress.

import { SUPABASE_URL, SUPABASE_KEY, CLOCK_RESYNC_MS } from './config.js';

const { createClient } = window.supabase;

// ── Identity ───────────────────────────────────────────────────────────────
// There is no login and no auth session. Each browser mints a 256-bit token on
// first visit and keeps it; the server stores only its SHA-256 hash. Presenting
// the token is what makes you a player, and holding on to it is what lets a
// refresh mid-game drop you back into your seat.

const TOKEN_KEY = 'wf-player-token';

function mintToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadToken() {
  try {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (/^[0-9a-f]{64}$/.test(stored ?? '')) return stored;
    const fresh = mintToken();
    localStorage.setItem(TOKEN_KEY, fresh);
    return fresh;
  } catch {
    // Private browsing, or storage blocked entirely. The game still works —
    // you just get a new identity if you reload.
    return mintToken();
  }
}

export const TOKEN = loadToken();

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  // The same token as a request header, which is what the RLS policies read.
  global: { headers: { 'x-wf-player': TOKEN } },
  realtime: { params: { eventsPerSecond: 20 } },
});

export class NetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ── Clock ──────────────────────────────────────────────────────────────────
// Round timing hangs off the server's `starts_at`, so every client needs to
// agree on "now" to within a second or so. Sample the server clock a few
// times and keep the reading with the fastest round trip.

let clockOffset = 0;

export async function syncClock(samples = 5) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const { data, error } = await sb.rpc('wf_server_time');
    const t1 = Date.now();
    if (error || !data) continue;
    const rtt = t1 - t0;
    const offset = Date.parse(data) + rtt / 2 - t1;
    if (!best || rtt < best.rtt) best = { rtt, offset };
  }
  if (best) clockOffset = best.offset;
  return best ?? { rtt: 0, offset: 0 };
}

export const serverNow = () => Date.now() + clockOffset;

let resyncTimer = null;
export function startClockResync() {
  clearInterval(resyncTimer);
  resyncTimer = setInterval(() => { syncClock(2).catch(() => {}); }, CLOCK_RESYNC_MS);
}

// ── RPCs ───────────────────────────────────────────────────────────────────
// Every one of these is a SECURITY DEFINER function that re-checks membership,
// host rights and timing server-side. The token is an argument rather than
// something the function infers, so writes never depend on header plumbing.

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, { p_token: TOKEN, ...args });
  if (error) throw new NetError(error.code || 'rpc_failed', error.message || `${fn} failed`);
  return data;
}

export const api = {
  createRoom: (mode, rounds, wordLength = null) =>
    rpc('wf_create_room', { p_mode: mode, p_total_rounds: rounds, p_word_length: wordLength }),
  joinRoom: (code) => rpc('wf_join_room', { p_code: code }),
  state: (roomId) => rpc('wf_state', { p_room: roomId }),
  heartbeat: (roomId) => rpc('wf_heartbeat', { p_room: roomId }),
  startGame: (roomId) => rpc('wf_start_game', { p_room: roomId }),
  rename: (roomId, name) => rpc('wf_rename', { p_room: roomId, p_name: name }),
  leaveRoom: (roomId) => rpc('wf_leave_room', { p_room: roomId }),
  finishGame: (roomId) => rpc('wf_finish_game', { p_room: roomId }),
  nextRound: (roomId) => rpc('wf_next_round', { p_room: roomId }),
  submitGuess: (roundId, word) => rpc('wf_submit_guess', { p_round: roundId, p_word: word }),
  checkSettle: (roundId) => rpc('wf_check_settle', { p_round: roundId }),
  applyMidModifier: (roundId) => rpc('wf_apply_mid_modifier', { p_round: roundId }),
  triggerLetterSwap: (roundId) => rpc('wf_trigger_letter_swap', { p_round: roundId }),
  // Returns the stake actually recorded, which the server clamps to what the
  // player has banked -- so the UI can show what was staked rather than what
  // was asked for.
  placeWager: (roundId, stake) => rpc('wf_place_wager', { p_round: roundId, p_stake: stake }),
};

// ── Realtime ───────────────────────────────────────────────────────────────

/**
 * One Broadcast channel per room, carrying:
 *
 *   poke  — room/round/guess state changed; the receiver reacts by refetching
 *           wf_state, which is the only place that ever applies the real
 *           row-level-security-gated visibility rules. Kept content-free on
 *           purpose so it can be sent after *any* change (round transitions,
 *           a Co-op teammate's guess) without duplicating access logic here.
 *   ghost — PvP only, and never anything but an aggregate: {attempts, hits,
 *           present, solved} describing the SENDER's own progress. The
 *           receiver renders it as "my opponent's progress" (self:false means
 *           you never receive your own). No word, no per-letter feedback —
 *           an opponent can feel the pressure without ever seeing a letter.
 *
 * Broadcast rather than postgres_changes because a realtime replication
 * stream carries no request headers and so could not evaluate the row-level
 * security policies that scope this data to room membership.
 */
export function openRoomChannel(roomId, handlers) {
  const channel = sb.channel(`wf:${roomId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on('broadcast', { event: 'poke' }, ({ payload }) => handlers.onPoke?.(payload));
  channel.on('broadcast', { event: 'ghost' }, ({ payload }) => handlers.onGhost?.(payload));

  channel.subscribe((status) => handlers.onStatus?.(status));

  return {
    channel,
    poke(payload) { channel.send({ type: 'broadcast', event: 'poke', payload }); },
    sendGhost(payload) { channel.send({ type: 'broadcast', event: 'ghost', payload }); },
    close() { sb.removeChannel(channel); },
  };
}
