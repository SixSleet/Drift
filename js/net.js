// Supabase plumbing: the player token, clock sync, RPC wrappers, and the
// realtime channel that carries live nudges.

import {
  SUPABASE_URL, SUPABASE_KEY,
  BROADCAST_INTERVAL_MS, NUDGE_REBROADCASTS, CLOCK_RESYNC_MS,
} from './config.js';

const { createClient } = window.supabase;

// ── Identity ───────────────────────────────────────────────────────────────
// There is no login and no auth session. Each browser mints a 256-bit token on
// first visit and keeps it; the server stores only its SHA-256 hash. Presenting
// the token is what makes you a player, and holding on to it is what lets a
// refresh mid-game drop you back into your seat.

const TOKEN_KEY = 'drift-player-token';

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
  global: { headers: { 'x-drift-player': TOKEN } },
  realtime: { params: { eventsPerSecond: 20 } },
});

export class NetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ── Clock ──────────────────────────────────────────────────────────────────
// Round timing hangs off the server's `starts_at`, so every client needs to
// agree on "now" to within a frame or two. Sample the server clock a few times
// and keep the reading from the fastest round trip, which has the least one-way
// ambiguity.

let clockOffset = 0;

export async function syncClock(samples = 5) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const { data, error } = await sb.rpc('drift_server_time');
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

// A device clock can wander over a long session — a laptop coming back from
// sleep is the common case — so the offset gets a periodic top-up rather than
// being trusted for the life of the tab.
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
  createRoom: (rounds) => rpc('drift_create_room', { p_total_rounds: rounds }),
  joinRoom: (code) => rpc('drift_join_room', { p_code: code }),
  state: (roomId) => rpc('drift_state', { p_room: roomId }),
  heartbeat: (roomId) => rpc('drift_heartbeat', { p_room: roomId }),
  startGame: (roomId) => rpc('drift_start_game', { p_room: roomId }),
  nextRound: (roomId) => rpc('drift_next_round', { p_room: roomId }),
  finishGame: (roomId) => rpc('drift_finish_game', { p_room: roomId }),
  nudges: (roundId) => rpc('drift_nudges_for', { p_round: roundId }),
  lockWager: (roundId, wager) => rpc('drift_lock_wager', { p_round: roundId, p_wager: wager }),
  publishTruth: (roundId, truth) => rpc('drift_publish_truth', { p_round: roundId, p_truth: truth }),
  // Carries the point that was clicked, not a precomputed direction — the
  // server, and every client, resolves the actual push direction at the tick
  // the nudge lands on rather than the tick it was clicked on.
  submitNudge: (roundId, ball, tick, x, y) =>
    rpc('drift_submit_nudge', {
      p_round: roundId, p_ball: ball, p_tick: tick, p_x: x, p_y: y,
    }),
  submitGuess: (roundId, ball, gx, gy) =>
    rpc('drift_submit_guess', { p_round: roundId, p_ball: ball, p_gx: gx, p_gy: gy }),
};

// ── Realtime ───────────────────────────────────────────────────────────────

/**
 * One Broadcast channel per room. It carries two things:
 *
 *   nudge — a player's single click, needed within a frame or two. The matching
 *           row in drift_nudges is what makes it durable; the broadcast is
 *           purely for latency.
 *   poke  — the host announcing that room or round state changed, with the new
 *           rows inline so everyone can act without waiting for a poll.
 *
 * Broadcast rather than postgres_changes because a realtime replication stream
 * carries no request headers, and so could not evaluate the row-level security
 * policies that scope this data to room membership.
 */
export function openRoomChannel(roomId, handlers) {
  const channel = sb.channel(`drift:${roomId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on('broadcast', { event: 'nudge' }, ({ payload }) => handlers.onNudge?.(payload));
  channel.on('broadcast', { event: 'poke' }, ({ payload }) => handlers.onPoke?.(payload));

  // Outgoing nudges are flushed on a fixed 10Hz tick rather than sent inline,
  // so a room full of simultaneous clicks costs a bounded number of messages.
  const queue = [];
  const timer = setInterval(() => {
    if (!queue.length) return;
    const batch = queue.splice(0, queue.length);
    for (const item of batch) {
      channel.send({ type: 'broadcast', event: 'nudge', payload: item.payload });
      if (--item.sendsLeft > 0) queue.push(item);
    }
  }, BROADCAST_INTERVAL_MS);

  channel.subscribe((status) => handlers.onStatus?.(status));

  return {
    channel,
    /** Queue a nudge for broadcast; resent a few times to ride out packet loss. */
    sendNudge(payload) {
      queue.push({ payload, sendsLeft: NUDGE_REBROADCASTS });
    },
    poke(payload) {
      channel.send({ type: 'broadcast', event: 'poke', payload });
    },
    close() {
      clearInterval(timer);
      sb.removeChannel(channel);
    },
  };
}
