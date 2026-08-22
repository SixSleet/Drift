// Round orchestration: phase clock, host duties (round advancement only —
// settling a finished round is validated server-side and any member can
// trigger it), input handling, and the live board.

import {
  MODES, ROUND_LEAD_MS, REVEAL_MS, BOARD_MS, SETTLE_RETRY_MS,
  POLL_MS, DEFAULT_ROUNDS, TIER_RANK,
} from './config.js';
import { api, syncClock, serverNow, openRoomChannel, startClockResync } from './net.js';
import { loadDictionary, isValidWord } from './words.js';
import { sfx } from './sfx.js';
import {
  $, showScreen, toast, renderPlayers, renderBoard, renderGrid,
  setPhase, setStatusLine, selectChip, buildLetterKeyboard, paintKeyboard,
} from './ui.js';

export class Game {
  constructor() {
    this.roomId = null;
    this.room = null;
    this.players = [];
    this.me = null;
    this.round = null;
    this.guessesByRound = new Map(); // round_id -> guess[]
    this.results = [];               // every settled wf_results row visible to us
    this.leaderboard = [];           // [{ player_id, total }]
    this.phase = 'idle';
    this.channel = null;
    this.ghost = null;               // pvp only: opponent's live aggregate
    this.local = this.#freshLocal();
    this.host = { advancing: false };
    this.settling = false;
    this.frame = this.frame.bind(this);
    buildLetterKeyboard((k) => this.handleKey(k));
  }

  #freshLocal() {
    return { active: '', shake: false, revealAt: 0, boardAt: 0, lastSettleTry: 0 };
  }

  get isHost() { return !!this.me?.is_host; }
  get mode() { return this.room?.mode; }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async boot() {
    await syncClock();
    startClockResync();
    requestAnimationFrame(this.frame);
  }

  async createRoom(mode, rounds = DEFAULT_ROUNDS) {
    const res = await api.createRoom(mode, rounds);
    await this.enterRoom(res.room_id);
    // Solo is a room of exactly one, forever — there is no one else to wait
    // for, so skip the lobby and go straight in.
    if (mode === 'solo') await this.startGame();
  }

  async joinRoom(code) {
    const res = await api.joinRoom(code);
    await this.enterRoom(res.room_id);
  }

  async startGame() {
    await api.startGame(this.roomId);
    this.room = { ...this.room, status: 'playing' };
    this.channel?.poke();
  }

  async enterRoom(roomId) {
    this.roomId = roomId;

    this.channel?.close();
    this.channel = openRoomChannel(roomId, {
      onPoke: () => this.refreshState(),
      onGhost: (payload) => { this.ghost = payload; },
    });

    await this.refreshState();

    clearInterval(this._poll);
    this._poll = setInterval(() => this.refreshState(), POLL_MS);
    clearInterval(this._hb);
    this._hb = setInterval(() => api.heartbeat(roomId).catch(() => {}), 20000);

    const url = new URL(location.href);
    url.searchParams.set('r', this.room.code);
    history.replaceState(null, '', url);

    this.#renderLobby();
    if (this.room.status === 'lobby' && this.mode !== 'solo') showScreen('screen-lobby');
  }

  async refreshState() {
    let state;
    try { state = await api.state(this.roomId); }
    catch { return; }
    this.#applyState(state);
  }

  #applyState(state) {
    if (!state) return;
    this.me = state.me ?? this.me;
    this.players = state.players ?? [];
    this.results = state.results ?? [];
    this.leaderboard = state.leaderboard ?? [];

    this.guessesByRound = new Map();
    for (const g of state.guesses ?? []) {
      if (!this.guessesByRound.has(g.round_id)) this.guessesByRound.set(g.round_id, []);
      this.guessesByRound.get(g.round_id).push(g);
    }
    for (const list of this.guessesByRound.values()) list.sort((a, b) => a.attempt_no - b.attempt_no);

    this.#onRoom(state.room);
    if (state.round) this.#onRound(state.round);
  }

  #renderLobby() {
    if (!this.room) return;
    $('#lobby-code').textContent = this.room.code;
    const modeInfo = MODES[this.room.mode];
    $('#lobby-mode').textContent = modeInfo?.label ?? '';
    $('#lobby-mode').style.color = modeInfo?.tint ?? '';
    renderPlayers(this.players, this.me?.id);
    const cap = modeInfo?.maxPlayers ?? 10;
    $('#lobby-count-max').textContent = `/${cap}`;
    const btn = $('#btn-start');
    const enough = this.mode === 'solo' || this.players.length >= 2;
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

  // ── Realtime application ─────────────────────────────────────────────

  #onRoom(row) {
    if (!row || row.id !== this.roomId) return;
    const before = this.room?.status;
    this.room = { ...this.room, ...row };
    if (row.status === 'finished' && before !== 'finished') this.#showFinal();
    this.#renderLobby();
  }

  #onRound(row) {
    if (!row || row.room_id !== this.roomId) return;
    if (this.round && row.id === this.round.id) {
      this.round = { ...this.round, ...row };
      return;
    }
    if (this.round && row.round_no <= this.round.round_no) return;
    this.#startRound(row);
  }

  #startRound(row) {
    this.round = row;
    this.local = this.#freshLocal();
    this.ghost = null;
    this.host.advancing = false;
    this.settling = false;
    showScreen('screen-game');
    $('#hud-round').textContent = `Round ${row.round_no}/${this.room.total_rounds}`;
    const chainEl = $('#hud-chain');
    if (row.chain_letter) {
      chainEl.hidden = false;
      chainEl.textContent = `starts with "${row.chain_letter.toUpperCase()}"`;
    } else {
      chainEl.hidden = true;
    }
    $('#ghost-bar').hidden = this.mode !== 'pvp';
    loadDictionary(row.word_length);
    paintKeyboard(new Map());
  }

  // ── Input ────────────────────────────────────────────────────────────

  handleKey(key) {
    if (this.phase !== 'live') return;
    if (key === 'ENTER') { this.#submit(); return; }
    if (key === 'BACK') {
      this.local.active = this.local.active.slice(0, -1);
      sfx.type();
      return;
    }
    if (/^[A-Z]$/.test(key) && this.local.active.length < this.round.word_length) {
      this.local.active += key;
      sfx.type();
    }
  }

  async #submit() {
    const word = this.local.active.toLowerCase();
    if (word.length !== this.round.word_length) {
      this.#invalidShake();
      return;
    }
    if (!(await isValidWord(word, this.round.word_length))) {
      this.#invalidShake();
      toast('Not a word I know.');
      return;
    }

    const roundId = this.round.id;
    try {
      const row = await api.submitGuess(roundId, word);
      this.local.active = '';
      if (!this.guessesByRound.has(roundId)) this.guessesByRound.set(roundId, []);
      this.guessesByRound.get(roundId).push(row);

      row.feedback.forEach((tier, i) => setTimeout(() => sfx.reveal(tier), i * 90));

      if (this.mode === 'pvp') {
        const mine = this.guessesByRound.get(roundId).filter((g) => g.player_id === this.me.id);
        this.channel?.sendGhost({
          attempts: mine.length,
          hits: row.feedback.filter((f) => f === 'hit').length,
          present: row.feedback.filter((f) => f === 'present').length,
          solved: row.feedback.every((f) => f === 'hit'),
        });
      } else {
        this.channel?.poke();
      }
    } catch (e) {
      if (e.code === 'P0019') toast('Already solved — nothing left to guess.');
      else if (e.code === 'P0018') toast('No guesses left.');
      else toast(e.message || 'Guess rejected.');
      this.#invalidShake();
    }
  }

  #invalidShake() {
    this.local.shake = true;
    sfx.invalid();
    setTimeout(() => { this.local.shake = false; }, 400);
  }

  // ── Completion / settlement ──────────────────────────────────────────

  #allHit(g) { return g.feedback.every((f) => f === 'hit'); }

  #roundSeemsFinished() {
    if (!this.round) return false;
    const gs = this.guessesByRound.get(this.round.id) ?? [];
    if (this.mode === 'coop') {
      return gs.length >= this.round.max_guesses || gs.some((g) => this.#allHit(g));
    }
    const mine = gs.filter((g) => g.player_id === this.me?.id);
    const myDone = mine.length >= this.round.max_guesses || mine.some((g) => this.#allHit(g));
    if (this.mode === 'solo') return myDone; // no opponent to wait for
    const oppDone = this.ghost ? (this.ghost.attempts >= this.round.max_guesses || this.ghost.solved) : false;
    return myDone && oppDone;
  }

  async #trySettle() {
    if (this.settling) return;
    const now = Date.now();
    if (now - this.local.lastSettleTry < SETTLE_RETRY_MS) return;
    this.local.lastSettleTry = now;
    this.settling = true;
    try {
      const row = await api.checkSettle(this.round.id);
      this.#onRound(row);
      if (row.status === 'settled') await this.refreshState();
    } catch {
      /* not finished yet from the server's point of view — retry later */
    } finally {
      this.settling = false;
    }
  }

  // ── Phase clock ──────────────────────────────────────────────────────

  #computePhase() {
    if (!this.room) return 'idle';
    if (this.room.status === 'lobby') return 'lobby';
    if (this.room.status === 'finished') return 'final';
    if (!this.round) return 'waiting';

    const t = serverNow() - Date.parse(this.round.starts_at);
    if (t < 0) return 'countdown';

    if (this.round.status === 'active') {
      return this.#roundSeemsFinished() ? 'settling' : 'live';
    }

    if (!this.local.revealAt) this.local.revealAt = Date.now();
    if (Date.now() - this.local.revealAt < REVEAL_MS) return 'reveal';
    if (!this.local.boardAt) this.local.boardAt = Date.now();
    return Date.now() - this.local.boardAt < BOARD_MS ? 'board' : 'next';
  }

  // ── Host duties: round advancement only ───────────────────────────────

  async #hostTick(phase) {
    if (!this.isHost || this.room?.status !== 'playing') return;

    if (!this.round) {
      try { this.#mintRound(await api.nextRound(this.roomId)); }
      catch (e) { toast(e.message); }
      return;
    }

    if (phase === 'next' && !this.host.advancing) {
      this.host.advancing = true;
      try {
        if (this.round.round_no >= this.room.total_rounds) {
          await api.finishGame(this.roomId);
          this.room = { ...this.room, status: 'finished' };
          this.channel?.poke();
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

  #mintRound(row) {
    this.#onRound(row);
    this.channel?.poke();
  }

  // ── Results ──────────────────────────────────────────────────────────

  #standings() {
    const byId = new Map(this.leaderboard.map((r) => [r.player_id, r.total]));
    const lastRound = new Map();
    if (this.round) {
      for (const r of this.results) {
        if (r.round_id === this.round.id) lastRound.set(r.player_id, r);
      }
    }
    return this.players
      .map((p) => ({
        name: p.name, color: p.color,
        total: byId.get(p.id) ?? 0,
        delta: lastRound.get(p.id)?.points ?? 0,
        isMe: p.id === this.me?.id,
      }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  #showFinal() {
    this.refreshState().then(() => {
      const rows = this.#standings();
      if (this.mode === 'coop') {
        $('#board-title').textContent = 'Final standings';
        const solvedRounds = new Set(
          this.results.filter((r) => r.solved).map((r) => r.round_id)).size;
        $('#board-note').textContent = `Team solved ${solvedRounds}/${this.room.total_rounds} rounds.`;
      } else if (this.mode === 'solo') {
        $('#board-title').textContent = 'Run complete';
        const solvedRounds = new Set(
          this.results.filter((r) => r.solved).map((r) => r.round_id)).size;
        $('#board-note').textContent = rows.length
          ? `${rows[0].total} points — solved ${solvedRounds}/${this.room.total_rounds} rounds.`
          : '';
      } else {
        $('#board-title').textContent = 'Final standings';
        $('#board-note').textContent = rows.length ? `${rows[0].name} wins the duel.` : '';
      }
      $('#btn-again').hidden = false;
      renderBoard(rows);
      showScreen('screen-board');
      sfx.win();
    });
  }

  // ── Frame ────────────────────────────────────────────────────────────

  frame() {
    requestAnimationFrame(this.frame);
    const phase = this.#computePhase();
    const changed = phase !== this.phase;
    this.phase = phase;
    if (changed) this.#onPhaseChange(phase);
    this.#hostTick(phase);
    if (phase === 'settling') this.#trySettle();

    if (!this.round) return;
    if (phase === 'lobby' || phase === 'final' || phase === 'waiting') return;

    this.#renderFrame(phase);
  }

  #renderFrame(phase) {
    const gs = this.guessesByRound.get(this.round.id) ?? [];
    const visible = this.mode === 'pvp' ? gs.filter((g) => g.player_id === this.me?.id) : gs;

    if (phase === 'countdown') {
      const secs = Math.ceil(-(serverNow() - Date.parse(this.round.starts_at)) / 1000);
      setStatusLine(`<div class="big">${secs > 0 ? secs : 'GO'}</div>`);
      renderGrid({
        wordLength: this.round.word_length, maxGuesses: this.round.max_guesses,
        guesses: [], active: '', canType: false,
      });
      return;
    }

    const playerColor = this.mode === 'coop'
      ? new Map(this.players.map((p) => [p.id, p.color])) : null;

    renderGrid({
      wordLength: this.round.word_length, maxGuesses: this.round.max_guesses,
      guesses: visible, active: this.local.active,
      canType: phase === 'live', playerColor, shake: this.local.shake,
    });

    const tiers = new Map();
    for (const g of visible) {
      g.word.split('').forEach((ch, i) => {
        const t = g.feedback[i];
        if (!tiers.has(ch) || TIER_RANK[t] > TIER_RANK[tiers.get(ch)]) tiers.set(ch, t);
      });
    }
    paintKeyboard(tiers);

    if (phase === 'live') {
      setStatusLine(this.mode === 'pvp' && this.ghost
        ? `<div class="small">Opponent: ${this.ghost.attempts}/${this.round.max_guesses} guesses</div>`
        : '');
      this.#renderGhostBar();
    } else if (phase === 'settling') {
      setStatusLine('<div class="small">Settling…</div>');
    } else if (phase === 'reveal') {
      setStatusLine(`<div class="reveal-word">${(this.round.revealed_secret ?? '').toUpperCase()}</div>`);
    } else if (phase === 'board' || phase === 'next') {
      $('#board-title').textContent = `After round ${this.round.round_no}`;
      $('#board-note').textContent = this.isHost ? 'Next round starting…' : 'Waiting for the host…';
      $('#btn-again').hidden = true;
      renderBoard(this.#standings());
    }
  }

  #renderGhostBar() {
    const bar = $('#ghost-bar');
    if (bar.hidden) return;
    const filled = this.ghost ? this.ghost.attempts : 0;
    const total = this.round.max_guesses;
    bar.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('i');
      if (i < filled) {
        dot.dataset.tier = this.ghost.solved && i === filled - 1 ? 'hit'
          : i < (this.ghost.hits ?? 0) ? 'hit' : 'present';
      }
      bar.appendChild(dot);
    }
  }

  #onPhaseChange(phase) {
    if (phase === 'countdown' || phase === 'live') {
      setPhase(phase === 'countdown' ? 'Get ready' : 'Live', null);
      showScreen('screen-game');
      if (phase === 'live') sfx.go();
    } else if (phase === 'settling') {
      setPhase('Settling', 'warn');
    } else if (phase === 'reveal') {
      setPhase('Reveal', null);
      const mine = (this.guessesByRound.get(this.round.id) ?? [])
        .filter((g) => this.mode === 'coop' || g.player_id === this.me?.id);
      if (mine.some((g) => this.#allHit(g))) sfx.solved();
      else sfx.lost();
    } else if (phase === 'board' || phase === 'next') {
      setPhase('Standings', null);
      $('#board-title').textContent = `After round ${this.round?.round_no ?? ''}`;
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
