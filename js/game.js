// Round orchestration: phase clock, host duties, input handling and scoring
// display. The host is the only client that writes round state; everybody else
// follows along over realtime and reproduces the round locally from its seed.

import {
  ARENA, DT_MS, NUDGE_LEAD_TICKS, NUDGE_RANGE,
  GUESS_WINDOW_MS, REVEAL_MS, LEADERBOARD_MS, DEFAULT_ROUNDS, POLL_MS,
} from './config.js';
import { Sim } from './sim.js';
import { Renderer, BALL_COLORS, BALL_NAMES } from './render.js';
import { api, syncClock, serverNow, openRoomChannel } from './net.js';
import {
  $, showScreen, toast, renderPlayers, renderBoard,
  setPhase, setOverlay, selectChip,
} from './ui.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Game {
  constructor() {
    this.renderer = new Renderer($('#arena'));
    this.roomId = null;
    this.room = null;
    this.players = [];
    this.me = null;
    this.round = null;
    this.sim = null;
    this.phase = 'idle';
    this.channel = null;
    this.allGuesses = new Map(); // `${round_id}:${player_id}` -> scored guess row
    this.local = this.#freshLocal();
    this.host = { advancing: false, publishing: false, minting: false };
    this.frame = this.frame.bind(this);
  }

  #freshLocal() {
    return {
      wager: 1,
      ball: 0,
      nudged: false,
      guessed: false,
      guessPoint: null,
      reconcileStarted: false,
      reconcileDone: false,
      freezeSeenAt: 0,
      guessOpenedAt: 0,
      revealAt: 0,
      revealFetched: false,
    };
  }

  get isHost() { return !!this.me?.is_host; }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async boot() {
    await syncClock();
    requestAnimationFrame(this.frame);
  }

  async startGame() {
    await api.startGame(this.roomId);
    this.room = { ...this.room, status: 'playing' };
    this.channel?.poke({ room: this.room });
  }

  async createRoom(rounds = DEFAULT_ROUNDS) {
    const res = await api.createRoom(rounds);
    await this.enterRoom(res.room_id);
  }

  async joinRoom(code) {
    const res = await api.joinRoom(code);
    await this.enterRoom(res.room_id);
  }

  async enterRoom(roomId) {
    this.roomId = roomId;

    this.channel?.close();
    this.channel = openRoomChannel(roomId, {
      onNudge: (payload) => this.#onRemoteNudge(payload),
      onPoke: (payload) => this.#onPoke(payload),
    });

    // One round trip brings back everything: room, roster, the running round,
    // and every guess and wager we are allowed to see. A refresh mid-game lands
    // here too, which is what puts you back in your seat.
    await this.refreshState();

    clearInterval(this._poll);
    this._poll = setInterval(() => this.refreshState(), POLL_MS);
    clearInterval(this._hb);
    this._hb = setInterval(() => api.heartbeat(roomId).catch(() => {}), 20000);

    const url = new URL(location.href);
    url.searchParams.set('r', this.room.code);
    history.replaceState(null, '', url);

    this.#renderLobby();
    if (this.room.status === 'lobby') showScreen('screen-lobby');
  }

  /**
   * Poll the authoritative room state. Broadcast pokes make round changes feel
   * instant; this is the backstop that keeps a client that missed one — or
   * joined late, or was backgrounded by the browser — from getting stuck.
   */
  async refreshState() {
    let state;
    try {
      state = await api.state(this.roomId);
    } catch {
      return; // transient; the next tick tries again
    }
    this.#applyState(state);
  }

  #applyState(state) {
    if (!state) return;
    this.me = state.me ?? this.me;
    this.players = state.players ?? [];
    this._standings = null;
    for (const g of state.guesses ?? []) {
      this.allGuesses.set(`${g.round_id}:${g.player_id}`, g);
    }
    this.#onRoom(state.room);
    if (state.round) this.#onRound(state.round);
    this.#renderLobby();
  }

  #renderLobby() {
    if (!this.room) return;
    $('#lobby-code').textContent = this.room.code;
    renderPlayers(this.players, this.me?.id);
    const btn = $('#btn-start');
    const enough = this.players.length >= 2;
    btn.hidden = !this.isHost;
    btn.disabled = !enough;
    $('#lobby-note').textContent = this.isHost
      ? (enough ? `Best of ${this.room.total_rounds} rounds.` : 'Waiting for one more player…')
      : 'Waiting for the host to start…';
    if (this.me) {
      $('#hud-you').textContent = this.me.name;
      $('#hud-you').style.color = this.me.color;
    }
  }

  // ── Realtime handlers ────────────────────────────────────────────────

  #onRoom(row) {
    if (!row || row.id !== this.roomId) return;
    const before = this.room?.status;
    this.room = { ...this.room, ...row };
    if (row.status === 'finished' && before !== 'finished') this.#showFinal();
    this.#renderLobby();
  }

  /**
   * The host broadcasts a poke with the new rows inline whenever room or round
   * state changes, so the rest of the table reacts immediately instead of
   * waiting up to a poll interval.
   */
  #onPoke(payload) {
    if (!payload) return;
    if (payload.room?.id === this.roomId) this.#onRoom(payload.room);
    if (payload.round?.room_id === this.roomId) this.#onRound(payload.round);
    this.refreshState();
  }

  #onRound(row) {
    if (!row || row.room_id !== this.roomId) return;
    if (this.round && row.id === this.round.id) {
      const hadTruth = !!this.round.truth;
      this.round = { ...this.round, ...row };
      if (!hadTruth && this.round.truth) this.local.revealAt = 0; // reveal starts on next frame
      return;
    }
    if (this.round && row.round_no <= this.round.round_no) return;
    this.#startRound(row);
  }

  #onRemoteNudge(payload) {
    if (!this.sim || !this.round || payload?.round_id !== this.round.id) return;
    if (this.sim.addNudge(payload)) {
      const p = this.sim.positions()[payload.ball_index];
      const who = this.players.find((x) => x.id === payload.player_id);
      if (p) this.renderer.ping(p.x - payload.dx * 40, p.y - payload.dy * 40, who?.color ?? '#ffffff');
    }
  }

  // ── Round setup ──────────────────────────────────────────────────────

  /** Host-side: adopt a freshly minted round and tell the room about it. */
  #mintRound(row) {
    this.#onRound(row);
    this.channel?.poke({ round: row });
  }

  #startRound(row) {
    this.round = row;
    this.sim = new Sim(row);
    this._standings = null;
    this.local = this.#freshLocal();
    this.host.publishing = false;
    this.host.advancing = false;
    showScreen('screen-game');
    $('#hud-round').textContent = `Round ${row.round_no}/${this.room.total_rounds}`;
    selectChip($('#wager-chips'), 'wager', 1);
    [...$('#wager-chips').querySelectorAll('.chip')].forEach((c) => { c.disabled = false; });
    this.#renderBallChips(row.ball_count);
    this.#setNudgeState('Ready', false);
    // The wager defaults to 1, so persist it up front: a player who never taps
    // still has a wager on record rather than being scored as an absentee.
    api.lockWager(row.id, 1).catch(() => {});
  }

  #renderBallChips(count) {
    const group = $('#ball-group');
    const chips = $('#ball-chips');
    group.hidden = count < 2;
    chips.innerHTML = '';
    if (count < 2) return;
    for (let i = 0; i < count; i++) {
      const b = document.createElement('button');
      b.className = 'chip chip-ball' + (i === 0 ? ' is-on' : '');
      b.type = 'button';
      b.dataset.ball = String(i);
      const dot = document.createElement('i');
      dot.style.background = BALL_COLORS[i % BALL_COLORS.length];
      b.append(dot, document.createTextNode(BALL_NAMES[i]));
      chips.appendChild(b);
    }
  }

  #setNudgeState(text, spent) {
    const el = $('#nudge-state');
    el.textContent = text;
    el.dataset.spent = spent ? '1' : '0';
  }

  // ── Input ────────────────────────────────────────────────────────────

  setWager(w) {
    this.local.wager = w;
    if (this.round) api.lockWager(this.round.id, w).catch((e) => toast(e.message));
  }

  setBall(i) { this.local.ball = i; }

  handleArenaClick(event) {
    if (!this.round || !this.sim) return;
    const p = this.renderer.toArena(event);
    if (p.x < 0 || p.y < 0 || p.x > ARENA.w || p.y > ARENA.h) return;
    if (this.phase === 'guess') this.#placeGuess(p);
    else if (this.phase === 'live' || this.phase === 'blackout') this.#nudge(p);
  }

  /**
   * One click per player per round: it shoves the nearest ball directly away
   * from the point clicked, harder the closer you clicked to it.
   */
  #nudge(point) {
    if (this.local.nudged || !this.me) return;

    const positions = this.sim.positions();
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < positions.length; i++) {
      const d = Math.hypot(positions[i].x - point.x, positions[i].y - point.y);
      if (d < bestD) { bestD = d; best = i; }
    }

    const target = positions[best];
    let dx = target.x - point.x;
    let dy = target.y - point.y;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;

    const payload = {
      round_id: this.round.id,
      player_id: this.me.id,
      ball_index: best,
      // Scheduled slightly ahead of the local render tick so most clients apply
      // it without ever rewinding. Clamped so a last-instant click still lands.
      apply_tick: Math.min(this.sim.tick + NUDGE_LEAD_TICKS, this.sim.freezeTick - 1),
      dx, dy,
      strength: clamp(1 - bestD / NUDGE_RANGE, 0.18, 1),
    };

    this.local.nudged = true;
    this.sim.addNudge(payload);
    this.renderer.ping(point.x, point.y, this.me.color);
    this.#setNudgeState('Spent', true);

    this.channel?.sendNudge(payload);
    api.submitNudge(this.round.id, best, payload.apply_tick, dx, dy, payload.strength)
      .catch(() => toast('Your nudge did not reach the server.'));
  }

  #placeGuess(point) {
    if (this.local.guessed) return;
    this.local.guessed = true;
    this.local.guessPoint = { x: point.x, y: point.y, ball: this.local.ball };
    api.submitGuess(this.round.id, this.local.ball, point.x, point.y)
      .catch((e) => toast(e.message || 'Guess rejected.'));
  }

  // ── Nudge reconciliation ─────────────────────────────────────────────

  /**
   * Re-read the durable nudge rows and fold in anything the broadcast missed.
   * This is what guarantees the frame you are guessing against matches the one
   * the host will publish as truth.
   */
  async #reconcile() {
    if (!this.round) return;
    try {
      const rows = await api.nudges(this.round.id);
      for (const n of rows) this.sim.addNudge(n);
    } catch {
      /* the host's published truth is still the authority for scoring */
    } finally {
      this.local.reconcileDone = true;
    }
  }

  // ── Phase clock ──────────────────────────────────────────────────────

  #computePhase() {
    const r = this.round;
    if (!this.room) return 'idle';
    if (this.room.status === 'lobby') return 'lobby';
    if (this.room.status === 'finished') return 'final';
    if (!r) return 'waiting';

    const t = serverNow() - Date.parse(r.starts_at);
    if (t < 0) return 'countdown';
    if (t < r.duration_ms) return 'live';
    if (t < r.duration_ms + r.blackout_ms) return 'blackout';

    if (!r.truth) {
      const L = this.local;
      if (!L.freezeSeenAt) L.freezeSeenAt = Date.now();
      if (!L.reconcileStarted) { L.reconcileStarted = true; this.#reconcile(); }
      // Give reconciliation a moment before the clock starts, but never stall
      // the round on a slow request.
      if (!L.guessOpenedAt && (L.reconcileDone || Date.now() - L.freezeSeenAt > 700)) {
        L.guessOpenedAt = Date.now();
      }
      if (!L.guessOpenedAt) return 'settling';
      return Date.now() - L.guessOpenedAt < GUESS_WINDOW_MS ? 'guess' : 'settling';
    }

    if (!this.local.revealAt) this.local.revealAt = Date.now();
    return Date.now() - this.local.revealAt < REVEAL_MS ? 'reveal' : 'board';
  }

  // ── Host duties ──────────────────────────────────────────────────────

  async #hostTick() {
    if (!this.isHost || this.room?.status !== 'playing') return;

    if (!this.round && !this.host.minting) {
      this.host.minting = true;
      try { this.#mintRound(await api.nextRound(this.roomId)); }
      catch (e) { toast(e.message); }
      finally { this.host.minting = false; }
      return;
    }
    if (!this.round) return;

    const r = this.round;
    const freezeAt = Date.parse(r.starts_at) + r.duration_ms + r.blackout_ms;

    // Publish truth only once the guess window has closed — the moment it
    // lands, RLS opens up everyone's wagers and guesses.
    if (!r.truth && !this.host.publishing && serverNow() > freezeAt + GUESS_WINDOW_MS + 1200) {
      this.host.publishing = true;
      try {
        await this.#reconcile();
        this.sim.advanceTo(this.sim.freezeTick);
        const truth = this.sim.positions().map((p) => ({ x: p.x, y: p.y }));
        await api.publishTruth(r.id, truth);
        this.round = { ...this.round, truth };
        this.channel?.poke({ round: this.round });
      } catch (e) {
        this.host.publishing = false;
        toast(e.message || 'Could not settle the round.');
      }
      return;
    }

    if (this.phase === 'board' && !this.host.advancing) {
      if (Date.now() - this.local.revealAt < REVEAL_MS + LEADERBOARD_MS) return;
      this.host.advancing = true;
      try {
        if (r.round_no >= this.room.total_rounds) {
          await api.finishGame(this.roomId);
          this.room = { ...this.room, status: 'finished' };
          this.channel?.poke({ room: this.room });
          this.#showFinal();
        } else {
          this.#mintRound(await api.nextRound(this.roomId));
        }
      } catch (e) {
        this.host.advancing = false;
        toast(e.message);
      }
    }
  }

  // ── Results ──────────────────────────────────────────────────────────

  async #refreshResults() { await this.refreshState(); }

  #standings() {
    // Recomputed only when a scored guess lands, not on every frame.
    if (this._standings) return this._standings;
    const totals = new Map();
    const lastRound = new Map();
    for (const g of this.allGuesses.values()) {
      totals.set(g.player_id, (totals.get(g.player_id) ?? 0) + (g.points ?? 0));
      if (this.round && g.round_id === this.round.id) lastRound.set(g.player_id, g);
    }
    this._standings = this.players
      .map((p) => {
        const last = lastRound.get(p.id);
        return {
          name: p.name,
          color: p.color,
          total: totals.get(p.id) ?? 0,
          delta: last?.points ?? 0,
          streak: last?.streak ?? 0,
          isMe: p.id === this.me?.id,
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    return this._standings;
  }

  #revealView() {
    if (!this.round?.truth) return null;
    const guesses = [];
    for (const g of this.allGuesses.values()) {
      if (g.round_id !== this.round.id) continue;
      const p = this.players.find((x) => x.id === g.player_id);
      if (!p) continue;
      guesses.push({
        x: g.gx, y: g.gy, ball: g.ball_index,
        color: p.color, points: g.points ?? 0, mine: p.id === this.me?.id,
      });
    }
    return { truth: this.round.truth, guesses };
  }

  #showFinal() {
    this.#refreshResults().then(() => {
      const rows = this.#standings();
      $('#board-title').textContent = 'Final standings';
      $('#board-note').textContent = rows.length ? `${rows[0].name} wins.` : '';
      $('#btn-again').hidden = false;
      renderBoard(rows);
      showScreen('screen-board');
    });
  }

  // ── Frame ────────────────────────────────────────────────────────────

  frame() {
    requestAnimationFrame(this.frame);
    const phase = this.#computePhase();
    const changed = phase !== this.phase;
    this.phase = phase;
    if (changed) this.#onPhaseChange(phase);
    if (this.isHost) this.#hostTick();

    if (!this.round || !this.sim) return;
    if (phase === 'lobby' || phase === 'final') return;

    const r = this.round;
    const t = serverNow() - Date.parse(r.starts_at);
    const targetTick = Math.max(0, Math.floor(t / DT_MS));
    this.sim.advanceTo(targetTick);

    const view = {
      sim: this.sim,
      layout: this.sim.layout,
      showTrails: true,
      ballsHidden: phase !== 'countdown' && phase !== 'live',
      // Once the balls are hidden, all anyone gets is where they were last seen.
      trails: phase === 'countdown' || phase === 'live' ? this.sim.trails : (this.sim.lastSeen ?? []),
      calledBall: this.local.ball,
      marker: null,
      reveal: null,
      dim: 0,
      guessRing: null,
    };

    if (phase === 'countdown') {
      view.ballsHidden = false;
      view.showTrails = false;
      const secs = Math.ceil(-t / 1000);
      setOverlay(`<div>${secs > 0 ? secs : 'GO'}</div>`, '#4bd0ff');
    } else if (phase === 'live') {
      setOverlay(this.local.nudged ? '' : '<div style="font-size:.5em;opacity:.5">click to nudge</div>');
    } else if (phase === 'blackout') {
      view.dim = 0.25;
      setOverlay('<div style="opacity:.75">WHERE IS IT?</div>', '#ff4d9d');
    } else if (phase === 'guess') {
      const left = GUESS_WINDOW_MS - (Date.now() - this.local.guessOpenedAt);
      view.guessRing = clamp(left / GUESS_WINDOW_MS, 0, 1);
      view.dim = 0.32;
      if (this.local.guessPoint) {
        view.marker = { ...this.local.guessPoint, color: this.me?.color };
        setOverlay('<div style="font-size:.5em;opacity:.6">locked in</div>');
      } else {
        setOverlay(`<div style="font-size:.62em">CLICK YOUR BALL${
          r.ball_count > 1 ? ` <span style="opacity:.6">(${BALL_NAMES[this.local.ball]})</span>` : ''}</div>`,
          '#ffd166');
      }
    } else if (phase === 'settling') {
      view.dim = 0.4;
      if (this.local.guessPoint) view.marker = { ...this.local.guessPoint, color: this.me?.color };
      setOverlay('<div style="font-size:.5em;opacity:.6">settling…</div>');
    } else if (phase === 'reveal') {
      view.ballsHidden = true;
      view.showTrails = false;
      view.dim = 0.42;
      view.reveal = this.#revealView();
      const mine = view.reveal?.guesses.find((g) => g.mine);
      setOverlay(mine
        ? `<div>+${mine.points}</div>`
        : '<div style="font-size:.6em;opacity:.7">no guess</div>',
        mine?.points ? '#7be495' : '#8d95bd');
    }

    this.renderer.draw(view);
    $('#hud-score').textContent = this.#standings().find((s) => s.isMe)?.total ?? 0;
  }

  #onPhaseChange(phase) {
    if (phase === 'countdown' || phase === 'live') {
      setPhase(phase === 'countdown' ? 'Get ready' : 'Live', null);
      showScreen('screen-game');
    } else if (phase === 'blackout') {
      setPhase('Balls hidden', 'hot');
      // Wagers close with the live phase; the tap stops mattering here.
      [...$('#wager-chips').querySelectorAll('.chip')].forEach((c) => { c.disabled = true; });
    } else if (phase === 'guess') {
      setPhase('Guess!', 'warn');
    } else if (phase === 'settling') {
      setPhase('Settling', null);
    } else if (phase === 'reveal') {
      setPhase('Reveal', null);
      if (!this.local.revealFetched) {
        this.local.revealFetched = true;
        this.#refreshResults();
      }
    } else if (phase === 'board') {
      $('#board-title').textContent = `After round ${this.round?.round_no ?? ''}`;
      $('#board-note').textContent = this.isHost ? 'Next round starting…' : 'Waiting for the host…';
      $('#btn-again').hidden = true;
      renderBoard(this.#standings());
      showScreen('screen-board');
    } else if (phase === 'waiting') {
      setPhase('Waiting', null);
    } else if (phase === 'final') {
      this.#showFinal();
    }
  }
}
