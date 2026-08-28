// Round orchestration: phase clock, host duties (round advancement only —
// settling a finished round is validated server-side and any member can
// trigger it), input handling, and the live board.

import {
  MODES, ROUND_LEAD_MS, ROUND_TIME_MS, REVEAL_MS, BOARD_MS, SETTLE_RETRY_MS,
  POLL_MS, DEFAULT_ROUNDS, DEFAULT_WORD_LENGTH, TIER_RANK, EVENTS,
  TICK_START_MS, EVENT_CARD_MS, FADE_INK_MS, WAGER_STAKES,
} from './config.js';
import { api, syncClock, serverNow, openRoomChannel, startClockResync } from './net.js';
import { loadDictionary, isValidWord } from './words.js';
import { sfx } from './sfx.js';
import { music } from './music.js';
import {
  $, showScreen, toast, renderPlayers, renderBoard, renderGrid,
  setPhase, setStatusLine, selectChip, buildLetterLegend, paintLetterLegend,
  renderRailLeft, renderRailRight, resetRails, setRoundRecap,
} from './ui.js';
import { startRoomEvents } from './room-events.js';
import {
  cipherCounts, lockdownViolation, bannedLetterViolation,
  isTotalMiss, suddenDeathOver, fadedRows,
} from './round-rules.js';

const CONFETTI_COLORS = ['#dfae52', '#cc6f56', '#94b073', '#e2a259', '#cf8465'];

export class Game {
  constructor() {
    this.roomId = null;
    this.room = null;
    this.players = [];      // still here
    this.everyone = [];     // ...plus anyone who left mid-match
    this.me = null;
    this.round = null;
    this.guessesByRound = new Map(); // round_id -> guess[]
    this.results = [];               // every settled wf_results row visible to us
    this.leaderboard = [];           // [{ player_id, total }]
    this.phase = 'idle';
    this.won = false;              // set once the match ends; drives the final theme
    this.channel = null;
    this.ghost = null;               // pvp only: opponent's live aggregate
    // The two client-side rule slots, kept separate so a mid-round blackout
    // can't switch off a cipher/lockdown/fading-ink round (see #showMidModifier).
    this.roundRule = null;           // from the round-start event
    this.midRule = null;             // from the mid-round modifier
    this.local = this.#freshLocal();
    this.host = { advancing: false };
    this.settling = false;
    this.frame = this.frame.bind(this);
    buildLetterLegend();
  }

  #freshLocal() {
    return {
      active: '', shake: false, revealAt: 0, boardAt: 0, lastSettleTry: 0, lastTickSecond: null,
      midModifierShown: false,     // we have applied this round's modifier client-side
      midModifierAnnounced: false, // ...and the banner/sound have been shown for it
      stake: 0,                    // wager rounds: what we actually staked
      diedAt: 0,                   // sudden death: when our total miss landed
    };
  }

  get isHost() { return !!this.me?.is_host; }
  get mode() { return this.room?.mode; }

  // ── Lifecycle ────────────────────────────────────────────────────────

  async boot() {
    await syncClock();
    startClockResync();
    requestAnimationFrame(this.frame);
  }

  async createRoom(mode, rounds = DEFAULT_ROUNDS, wordLength = DEFAULT_WORD_LENGTH) {
    const res = await api.createRoom(mode, rounds, wordLength);
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
    // `players` is who is still here; `everyone` includes those who left, so
    // the standings can still show a score they earned before going.
    this.everyone = state.players ?? [];
    this.players = this.everyone.filter((p) => !p.left_at);
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
    // Everyone in the room plays the host's word length, so everyone needs
    // to be told what it is -- a joiner had no way of knowing before.
    const wl = this.room.word_length
      ? `${this.room.word_length}-letter words` : 'mixed 4- and 5-letter words';
    const setup = `${this.room.total_rounds} rounds · ${wl}.`;
    $('#lobby-note').textContent = this.isHost
      ? (enough ? setup : 'Waiting for one more player…')
      : `${setup} Waiting for the host to start…`;
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
      const wasFired = this.round.mid_modifier_fired;
      this.round = { ...this.round, ...row };
      // A modifier is global, so its announcement has to be global too.
      // Only one client's clock actually applies it, and #checkMidModifier
      // bails out early on anyone whose refresh brought back
      // mid_modifier_fired before their own clock crossed the mark -- which
      // left them with a halved clock, a dark legend or doubled points and
      // nothing on screen to explain why. Announce off the row changing,
      // not off being the one who changed it.
      if (this.round.mid_modifier_fired && !wasFired && !this.local.midModifierAnnounced) {
        this.local.midModifierShown = true;
        this.#showMidModifier(this.round.mid_modifier);
      }
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
    resetRails();
    loadDictionary(row.word_length);

    // `rule` actually changes how this round is played, not just how it
    // looks -- read directly off EVENTS elsewhere in the render loop instead
    // of re-deriving it from row.event each time. blackout, cipher, lockdown,
    // fading_ink, banned_letter, sudden_death and wager all arrive this way.
    this.roundRule = EVENTS[row.event]?.rule ?? null;
    // Whatever the previous round's mid-round modifier was, it does not
    // carry over -- without this a blackout that fired last round would
    // leave this round's legend dark forever.
    this.midRule = null;
    this.#paintLegendMode();
    paintLetterLegend(new Map());
    this.#renderRoundRulePill();

    this.#applyEvent(row.event);
    this.#offerWager();
  }

  /**
   * A standing rule that has to stay legible for the whole round, as a HUD
   * pill. Unlike the mid-round banner these never time out -- a banned
   * letter you can no longer see is a trap rather than a rule, and the same
   * goes for knowing your round can end on one bad guess.
   */
  #renderRoundRulePill() {
    const el = $('#hud-hint');
    if (!el) return;
    let label = null;
    let tone = null;
    if (this.roundRule === 'banned_letter' && this.round?.banned_letter) {
      label = `🚫 no ${String(this.round.banned_letter).toUpperCase()}`;
      tone = 'ban';
    } else if (this.roundRule === 'sudden_death') {
      label = '🩸 sudden death';
      tone = 'ban';
    } else if (this.roundRule === 'wager' && this.local.stake > 0) {
      label = `🎲 staked ${this.local.stake}`;
      tone = 'stake';
    }
    el.hidden = !label;
    el.textContent = label ?? '';
    if (tone) el.dataset.tone = tone; else el.removeAttribute('data-tone');
  }

  /**
   * WAGER: three chips on the countdown card, live only while the round has
   * not started. The stake is server-clamped to what the player has banked,
   * so what comes back is what was actually staked -- which is what gets
   * shown, rather than what was asked for.
   */
  #offerWager() {
    const box = $('#wager-box');
    if (!box) return;
    box.innerHTML = '';
    box.hidden = this.roundRule !== 'wager';
    if (box.hidden) return;

    const banked = this.leaderboard.find((r) => r.player_id === this.me?.id)?.total ?? 0;
    const label = document.createElement('p');
    label.className = 'wager-label';
    label.textContent = banked > 0
      ? `Stake up to ${banked} on solving this one`
      : 'Nothing banked yet — nothing to stake';
    box.appendChild(label);

    if (banked <= 0) return;

    const row = document.createElement('div');
    row.className = 'wager-row';
    for (const stake of WAGER_STAKES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip wager-chip';
      btn.textContent = String(stake);
      btn.disabled = stake > banked;
      btn.addEventListener('click', () => this.#placeWager(stake, row));
      row.appendChild(btn);
    }
    box.appendChild(row);
  }

  async #placeWager(stake, row) {
    try {
      const got = await api.placeWager(this.round.id, stake);
      this.local.stake = got ?? stake;
      [...row.children].forEach((b) => {
        b.classList.toggle('is-on', Number(b.textContent) === this.local.stake);
      });
      sfx.wagerPlaced();
      toast(`Staked ${this.local.stake}.`);
      this.#renderRoundRulePill();
    } catch (e) {
      // Too late, or the round moved on. Either way the stake did not land,
      // and saying so is better than leaving a chip looking selected.
      toast(e.code === 'P0028' ? 'Too late to stake on this one.' : (e.message || 'Stake rejected.'));
    }
  }

  /** A round's random event — announced once, at the moment it starts. */
  #applyEvent(event) {
    const el = $('#hud-event');
    const info = EVENTS[event];
    const flash = $('#event-flash');
    const screen = $('#screen-game');
    const card = $('#event-card');

    screen.classList.remove('screen-shake');
    flash.classList.remove('is-active');

    if (!info) {
      el.hidden = true; el.classList.remove('is-rare');
      card.hidden = true;
      return;
    }

    el.hidden = false;
    el.classList.toggle('is-rare', !!info.rare);
    el.style.setProperty('--tint', info.tint);
    el.textContent = `${info.emoji} ${info.label}`;
    // Re-trigger the CSS pop-in even if the previous round had the same event.
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';

    flash.style.setProperty('--tint', info.tint);
    flash.dataset.fx = info.fx ?? '';
    void flash.offsetWidth;
    flash.classList.add('is-active');

    if (info.fx === 'siren' || info.fx === 'jackpot') {
      void screen.offsetWidth;
      screen.classList.add('screen-shake');
      setTimeout(() => screen.classList.remove('screen-shake'), 500);
    }
    if (info.fx === 'coins' || info.fx === 'jackpot') {
      this.#spawnConfetti(info.fx === 'jackpot' ? 60 : 26);
    }

    // The full-screen card: dominant, readable for the whole 5s countdown
    // (EVENT_CARD_MS matches ROUND_LEAD_MS/wf_next_round's starts_at offset)
    // so nobody has to squint at the small HUD pill to know what changed.
    card.hidden = false;
    card.dataset.fx = info.fx ?? '';
    card.style.setProperty('--tint', info.tint);
    $('#event-card-emoji').textContent = info.emoji;
    $('#event-card-label').textContent = info.label;
    $('#event-card-blurb').textContent = info.blurb;
    card.classList.remove('is-active');
    void card.offsetWidth;
    card.classList.add('is-active');
    clearTimeout(this._eventCardTimer);
    this._eventCardTimer = setTimeout(() => { card.hidden = true; }, EVENT_CARD_MS);

    sfx.event(event);
  }

  /** A one-shot burst of falling confetti pieces, self-removing after they land. */
  #spawnConfetti(count) {
    const layer = $('#confetti-layer');
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('i');
      piece.className = 'confetti-piece';
      piece.style.setProperty('--x', `${Math.random() * 100}%`);
      piece.style.setProperty('--c', CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      piece.style.setProperty('--rot', `${Math.random() * 360}deg`);
      piece.style.setProperty('--dur', `${1.1 + Math.random() * 0.9}s`);
      piece.style.setProperty('--delay', `${Math.random() * 0.4}s`);
      piece.addEventListener('animationend', () => piece.remove());
      layer.appendChild(piece);
    }
  }

  /**
   * The global mid-round modifier. Unlike the room events below it, this is
   * server-authoritative and shared: everyone in the room gets it, at the
   * same point on the round's own clock. midModifierShown only guards against
   * re-firing every frame once we're past the mark; mid_modifier_fired
   * (server-confirmed, arrives on the next refresh) is the real "already
   * resolved". Whoever's clock crosses first applies it for everybody.
   */
  #checkMidModifier() {
    const r = this.round;
    if (!r || r.mid_modifier === 'none' || r.mid_modifier_fired) return;
    if (this.local.midModifierShown) return;
    const elapsed = serverNow() - Date.parse(r.starts_at);
    if (elapsed < r.mid_modifier_at_ms) return;
    this.local.midModifierShown = true;

    if (r.mid_modifier === 'letter_swap') this.#triggerLetterSwap();
    else this.#applyMidModifier(r.mid_modifier);
  }

  /**
   * Everything a mid-round modifier does to *this* screen: the sting, the
   * banner, the soundtrack, and the one rule that is client-side.
   * Idempotent, because two paths reach it -- our own clock crossing the
   * mark, and the round row coming back already fired from someone else's.
   */
  #showMidModifier(kind) {
    if (!kind || kind === 'none') return;
    if (this.local.midModifierAnnounced) return;
    const info = EVENTS[kind];
    if (!info) return;
    this.local.midModifierAnnounced = true;
    sfx.event(kind);
    this.#announceMidModifier(kind);
    music.set(this.musicTheme());
    // Kept apart from roundRule rather than overwriting it. A cipher,
    // or lockdown round can also roll a mid-round blackout (wf_next_round
    // only excludes the round's OWN event from that pool), and assigning
    // over roundRule there would quietly switch the round-start modifier
    // off: the board would start showing colours again halfway through a
    // cipher round, which hands back exactly the information it exists to
    // withhold. The two rules are independent, so they are stored that way.
    if (info.rule) {
      this.midRule = info.rule;
      this.#paintLegendMode();
    }
  }

  /**
   * The legend goes dark for blackout (from either roll) and for cipher,
   * which has no honest per-letter colour to show in the first place.
   */
  #paintLegendMode() {
    $('#letter-legend').classList.toggle('is-blackout',
      this.roundRule === 'blackout' || this.roundRule === 'cipher'
      || this.midRule === 'blackout');
  }

  /** Blitz / Double Points / Blackout / Jackpot, landing mid-round. */
  async #applyMidModifier(kind) {
    try {
      await api.applyMidModifier(this.round.id);
    } catch {
      // Another client's clock beat us to it, or we asked too early. Their
      // refresh broadcasts the same result to everyone, so there is nothing
      // to do here -- but still show the banner, since the modifier is real.
    }
    this.#showMidModifier(kind);
    this.channel?.poke();
    await this.refreshState();
  }

  /** Coop only: swaps two players' guess feedback. Any member can trigger
   * it; the server's mid_modifier_fired flag makes every call but the first a
   * harmless no-op, so racing coop teammates never double-apply it. */
  async #triggerLetterSwap() {
    try {
      await api.triggerLetterSwap(this.round.id);
    } catch {
      // Another teammate's client already resolved it (or the window
      // closed) -- their refresh will show the same result to everyone.
    }
    this.#showMidModifier('letter_swap');
    this.channel?.poke();
    await this.refreshState();
  }

  /**
   * A banner rather than the countdown's full-screen card: play is already in
   * progress, so this must not cover the board the way the round-start card
   * legitimately can.
   */
  #announceMidModifier(kind) {
    const info = EVENTS[kind];
    if (!info) return;
    const el = $('#mid-banner');
    if (!el) return;
    el.style.setProperty('--tint', info.tint || 'var(--accent)');
    el.innerHTML = `<span class="mid-banner-emoji">${info.emoji}</span>` +
                   `<span class="mid-banner-label">${info.label}</span>` +
                   `<span class="mid-banner-blurb">${info.midBlurb || info.blurb}</span>`;
    el.hidden = false;
    el.classList.remove('is-live');
    void el.offsetWidth;             // restart the animation on a repeat
    el.classList.add('is-live');
    clearTimeout(this.midBannerTimer);
    this.midBannerTimer = setTimeout(() => {
      el.classList.remove('is-live');
      el.hidden = true;
    }, 3600);
  }

  // ── Input ────────────────────────────────────────────────────────────

  handleKey(key) {
    if (this.phase !== 'live') return;
    // Out under sudden death: the board stays up to read, but there is
    // nothing left to type into it.
    if (this.#isDead()) return;
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

    // LOCKDOWN and BANNED LETTER both rule words out rather than punishing
    // them. Checked here, before the guess is spent, so an illegal word
    // costs nothing but the keystrokes -- they are constraints on what you
    // may play, not traps that burn an attempt.
    if (this.roundRule === 'lockdown') {
      const why = lockdownViolation(word, this.#myGuesses());
      if (why) { this.#invalidShake(); toast(why); return; }
    }
    if (this.roundRule === 'banned_letter') {
      const why = bannedLetterViolation(word, this.round);
      if (why) { this.#invalidShake(); toast(why); return; }
    }

    const roundId = this.round.id;
    try {
      const row = await api.submitGuess(roundId, word);
      this.local.active = '';
      if (!this.guessesByRound.has(roundId)) this.guessesByRound.set(roundId, []);
      this.guessesByRound.get(roundId).push(row);

      // Under cipher there are no per-tile chimes: they play in tile order
      // with a different pitch per tier, so they would spell out the exact
      // positions cipher exists to withhold.
      if (this.roundRule === 'cipher') {
        sfx.cipherRow();
      } else {
        row.feedback.forEach((tier, i) => setTimeout(() => sfx.reveal(tier), i * 90));
      }

      // SUDDEN DEATH: a guess that scored nothing at all is the end of it.
      // The server reaches the same conclusion in wf_check_settle -- this is
      // here so the board stops taking input the instant it happens, rather
      // than staying live through a settle round-trip the player would spend
      // typing a guess that can never land.
      if (this.roundRule === 'sudden_death' && isTotalMiss(row.feedback)) {
        this.local.diedAt = Date.now();
        setTimeout(() => sfx.suddenDeath(), row.feedback.length * 90 + 60);
        toast(this.mode === 'coop'
          ? "Nothing at all. You're out — the team plays on."
          : "Nothing at all. You're out.");
      } else if (row.feedback.every((f) => f !== 'hit')) {
        // "Not even one" -- a distinct sting after the whole row's flipped,
        // on top of the row's own is-whiff shake (see renderGrid).
        setTimeout(() => sfx.whiff(), row.feedback.length * 90 + 80);
      }

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
      else if (e.code === 'P0021') toast("Time's up for this round.");
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

  /**
   * The rows this player is playing against: the whole shared board in Coop,
   * only your own in PvP and Solo. Raw, server-truth feedback -- this is
   * what lockdown and sudden death both read.
   */
  #myGuesses() {
    const gs = this.guessesByRound.get(this.round.id) ?? [];
    return this.mode === 'coop' ? gs : gs.filter((g) => g.player_id === this.me?.id);
  }

  /**
   * SUDDEN DEATH: am *I* out? Always my own rows, even in Coop, where the
   * board is shared but the elimination is not -- a teammate's empty guess
   * takes them out and leaves the rest of the team playing.
   *
   * Read off the board rather than off local state so it survives a refresh:
   * the rows are the record, `local.diedAt` only exists to time the sting.
   */
  #isDead() {
    if (this.roundRule !== 'sudden_death') return false;
    const gs = this.guessesByRound.get(this.round.id) ?? [];
    return suddenDeathOver(gs.filter((g) => g.player_id === this.me?.id));
  }

  #roundSeemsFinished() {
    if (!this.round) return false;
    const timeLimitMs = this.round.time_limit_ms ?? ROUND_TIME_MS;
    if (serverNow() - Date.parse(this.round.starts_at) >= timeLimitMs) return true; // round's own clock (blitz shortens it)

    const gs = this.guessesByRound.get(this.round.id) ?? [];
    // Sudden death takes out only the player who threw the total miss. In
    // Coop that means the round ends this way only once nobody is left who
    // can still play -- one careless teammate does not end it for everyone.
    const dead = this.roundRule === 'sudden_death';
    if (this.mode === 'coop') {
      const allOut = dead && this.players.length > 0 && this.players.every((p) =>
        suddenDeathOver(gs.filter((g) => g.player_id === p.id)));
      return gs.length >= this.round.max_guesses || gs.some((g) => this.#allHit(g)) || allOut;
    }
    const mine = gs.filter((g) => g.player_id === this.me?.id);
    const myDone = mine.length >= this.round.max_guesses || mine.some((g) => this.#allHit(g))
                   || (dead && suddenDeathOver(mine));
    if (this.mode === 'solo') return myDone; // no opponent to wait for

    // PvP: first to solve wins, so the round ends the instant either side
    // gets it — no need to wait for the other player to also finish.
    if (mine.some((g) => this.#allHit(g)) || this.ghost?.solved) return true;
    const oppExhausted = this.ghost ? this.ghost.attempts >= this.round.max_guesses : false;
    return myDone && oppExhausted;
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

  /** Rename yourself. Lobby only -- the server enforces that too. */
  async rename(name) {
    const res = await api.rename(this.roomId, name);
    await this.refreshState();
    return res?.name ?? name;
  }

  /**
   * Leave. Tells the server first so the other players find out, then tears
   * this client down locally -- polling and realtime included, or a room we
   * are no longer in keeps being fetched.
   */
  async leave() {
    try { await api.leaveRoom(this.roomId); }
    catch { /* already gone, or the room is finished; leaving is still fine */ }
    this.teardown();
  }

  /** Stop talking to the server, whatever the reason. */
  teardown() {
    clearInterval(this._poll);
    this._poll = null;
    this.stopRoomEvents?.();
    this.stopRoomEvents = null;
    this.channel?.close?.();
    this.channel = null;
    this.roomId = null;
    this.room = null;
    this.round = null;
    this.phase = 'idle';
    music.set('title');
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
    // Every settled round this player took part in — the standings show a
    // solve rate and an average alongside the raw score, so a big number
    // that came from two lucky rounds reads differently from a steady one.
    const form = new Map();
    for (const r of this.results) {
      let f = form.get(r.player_id);
      if (!f) form.set(r.player_id, f = { solved: 0, played: 0, guesses: 0 });
      f.played += 1;
      if (r.solved) { f.solved += 1; f.guesses += r.guesses_used ?? 0; }
    }
    return (this.everyone ?? this.players)
      .map((p) => {
        const f = form.get(p.id);
        return {
          name: p.name, color: p.color, left: !!p.left_at,
          total: byId.get(p.id) ?? 0,
          delta: lastRound.get(p.id)?.points ?? 0,
          isMe: p.id === this.me?.id,
          solved: f?.solved ?? 0,
          played: f?.played ?? 0,
          avgGuesses: f?.solved ? f.guesses / f.solved : 0,
        };
      })
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  /** "Round 3 · CHEAT — Fox got it in 4." Blank if there's nothing to say. */
  #roundRecap() {
    if (!this.round) return '';
    const word = (this.round.revealed_secret ?? '').toUpperCase();
    if (!word) return '';
    const mine = this.results.filter((r) => r.round_id === this.round.id);
    const solvers = mine.filter((r) => r.solved);
    let tail;
    if (!solvers.length) {
      tail = 'Nobody got it.';
    } else if (this.mode === 'coop') {
      const best = Math.min(...solvers.map((r) => r.guesses_used));
      tail = `Team solved it in ${best}.`;
    } else if (this.mode === 'solo') {
      tail = `Solved in ${solvers[0].guesses_used}.`;
    } else {
      const first = solvers.slice().sort((a, b) => a.guesses_used - b.guesses_used)[0];
      const who = this.players.find((p) => p.id === first.player_id);
      tail = `${who?.name ?? 'Someone'} got it in ${first.guesses_used}.`;
    }
    return `<b class="recap-word">${word}</b> <span>${tail}</span>`;
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
      setRoundRecap('');
      renderBoard(rows);
      showScreen('screen-board');
      // Win or lose gets its own music and its own sting -- the match
      // previously ended on the same fanfare either way, which made losing
      // feel like nothing had happened.
      this.won = this.#didWin(rows);
      music.set(this.won ? 'victory' : 'defeat');
      if (this.won) sfx.win(); else sfx.matchLost();
    });
  }

  /**
   * Did this player's match end well? Deliberately generous in the modes
   * where "winning" is not a ranking: Co-op is a team against the words, so
   * solving more than half of them counts; Solo is against yourself, so
   * anything but a blank counts.
   */
  #didWin(rows) {
    if (!rows.length) return false;
    const solvedRounds = new Set(
      this.results.filter((r) => r.solved).map((r) => r.round_id)).size;
    if (this.mode === 'coop') return solvedRounds * 2 > this.room.total_rounds;
    if (this.mode === 'solo') return solvedRounds > 0;
    // PvP: top of the table, and not tied with someone above you.
    return rows[0].isMe;
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
    if (phase === 'live') this.#checkMidModifier();

    if (!this.round) { $('#hud-timer').hidden = true; return; }
    if (phase === 'lobby' || phase === 'final' || phase === 'waiting') { $('#hud-timer').hidden = true; return; }

    this.#renderFrame(phase);
  }

  /**
   * What the music should be right now. One function rather than a `set()`
   * scattered through every transition: the answer depends on three things
   * at once (phase, the round's opening event, and any modifier that landed
   * mid-round), and working that out in each caller is how they drift apart.
   *
   * Room events are NOT considered here. Those are player-sided and take
   * the music over through music.override(), precisely so they never have
   * to be entangled with the shared, server-driven state below.
   */
  musicTheme() {
    if (!this.room || this.phase === 'idle') return 'title';
    if (this.phase === 'settling' || this.phase === 'reveal') return 'reveal';
    if (this.phase === 'final') return this.won ? 'victory' : 'defeat';
    if (this.phase === 'board' || this.phase === 'next') return 'standings';
    if (this.phase === 'countdown' || this.phase === 'live') {
      // A modifier that has actually landed outranks the round's opening
      // event: it is the more recent thing to have happened to the player.
      const fired = this.local?.midModifierShown || this.round?.mid_modifier_fired;
      const mid = fired ? this.round?.mid_modifier : null;
      const kind = mid && mid !== 'none' ? mid : this.round?.event;
      if (music.knows(kind)) return kind;
      // No event: the bed is the mode's own. A duel and a shared board are
      // not the same room to be sitting in.
      const bed = `live_${this.mode}`;
      return music.knows(bed) ? bed : 'live';
    }
    return 'lobby';
  }

  #renderTimer(phase) {
    const el = $('#hud-timer');
    if (phase !== 'live') { el.hidden = true; return; }
    const timeLimitMs = this.round.time_limit_ms ?? ROUND_TIME_MS;
    const remaining = Math.max(0, timeLimitMs - (serverNow() - Date.parse(this.round.starts_at)));
    const secs = Math.ceil(remaining / 1000);
    el.hidden = false;
    el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    el.classList.toggle('is-low', remaining <= 30000);
    el.classList.toggle('is-critical', remaining <= 10000);

    // An audible tick for the last stretch, once per second, pitch rising
    // as it nears zero — the "ticking timer" party-game clock feel.
    if (remaining <= TICK_START_MS && remaining > 0) {
      if (secs !== this.local.lastTickSecond) {
        this.local.lastTickSecond = secs;
        sfx.tick(secs);
      }
    } else {
      this.local.lastTickSecond = null;
    }
  }

  #renderFrame(phase) {
    this.#renderTimer(phase);
    const gs = this.guessesByRound.get(this.round.id) ?? [];
    const visible = this.mode === 'pvp' ? gs.filter((g) => g.player_id === this.me?.id) : gs;

    if (phase === 'countdown') {
      const secs = Math.ceil(-(serverNow() - Date.parse(this.round.starts_at)) / 1000);
      setStatusLine(`<div class="big">${secs > 0 ? secs : 'GO'}</div>`);
      const countEl = $('#event-card-count');
      if (countEl) countEl.textContent = secs > 0 ? `Starts in ${secs}…` : 'GO!';
      renderGrid({
        wordLength: this.round.word_length, maxGuesses: this.round.max_guesses,
        guesses: [], active: '', canType: false,
      });
      this.#renderRails([]);
      return;
    }

    // Past the countdown the betting window has closed -- the server refuses
    // a stake from here anyway (wf_place_wager checks starts_at), so leaving
    // the chips up would only offer something that can no longer happen.
    const wagerBox = $('#wager-box');
    if (wagerBox && !wagerBox.hidden) wagerBox.hidden = true;

    const playerColor = this.mode === 'coop'
      ? new Map(this.players.map((p) => [p.id, p.color])) : null;

    this.#renderRails(visible);

    // FADING INK: which rows have held their colour long enough to lose it.
    // Recomputed every frame off each row's own server timestamp, so this
    // keeps working across a refresh and cannot be paused by looking away.
    const faded = this.roundRule === 'fading_ink'
      ? fadedRows(visible, serverNow(), FADE_INK_MS) : null;

    // A player who is out under sudden death keeps their board but loses the
    // caret -- there is nothing left to type.
    const canType = phase === 'live' && !this.#isDead();

    renderGrid({
      wordLength: this.round.word_length, maxGuesses: this.round.max_guesses,
      guesses: visible, active: this.local.active,
      canType, playerColor, meId: this.me?.id ?? null,
      shake: this.local.shake,
      // Cipher hides where the hits are; the row is told only how many.
      cipher: this.roundRule === 'cipher',
      cipherCounts: this.roundRule === 'cipher'
        ? visible.map((g) => cipherCounts(g.feedback)) : null,
      faded,
    });

    // Cipher's legend would hand back exactly the per-letter knowledge the
    // modifier is withholding, so it goes dark alongside blackout's -- from
    // either roll (see #paintLegendMode).
    if (this.roundRule === 'blackout' || this.roundRule === 'cipher'
        || this.midRule === 'blackout') {
      paintLetterLegend(new Map());
    } else {
      const tiers = new Map();
      visible.forEach((g, i) => {
        // Under fading ink the legend is built from the rows that still have
        // their colour. Leaving it complete would make the modifier
        // pointless: the board would forget and the legend would remember
        // the same thing, one line further down the screen.
        if (faded?.[i]) return;
        // g.word comes back lowercase from the server; the legend's letters
        // are uppercase, so this has to match case or nothing gets painted.
        g.word.toUpperCase().split('').forEach((ch, j) => {
          const t = g.feedback[j];
          if (!tiers.has(ch) || TIER_RANK[t] > TIER_RANK[tiers.get(ch)]) tiers.set(ch, t);
        });
      });
      paintLetterLegend(tiers);
    }

    if (phase === 'live') {
      setStatusLine(this.mode === 'pvp' && this.ghost
        ? `<div class="small">Opponent: ${this.ghost.attempts}/${this.round.max_guesses} guesses</div>`
        : '');
    } else if (phase === 'settling') {
      setStatusLine('<div class="small">Settling…</div>');
    } else if (phase === 'reveal') {
      const word = `<div class="reveal-word">${(this.round.revealed_secret ?? '').toUpperCase()}</div>`;
      let sub = '';
      if (this.mode === 'pvp') {
        if (this.round.winner_player_id) {
          const iWon = this.round.winner_player_id === this.me?.id;
          const winner = this.players.find((p) => p.id === this.round.winner_player_id);
          sub = `<div class="small">${iWon ? 'You got it first!' : `${winner?.name ?? 'Your rival'} got it first.`}</div>`;
        } else {
          sub = '<div class="small">Nobody solved it in time.</div>';
        }
      }
      setStatusLine(word + sub);
    } else if (phase === 'board' || phase === 'next') {
      const last = this.round.round_no >= this.room.total_rounds;
      $('#board-title').textContent = last
        ? `After the last round` : `After round ${this.round.round_no}`;
      // There is no next round after the last one. Promising one and then
      // cutting to the final standings reads as the game losing its place.
      $('#board-note').textContent = last
        ? 'Working out the final standings…'
        : (this.isHost ? 'Next round starting…' : 'Waiting for the host…');
      $('#btn-again').hidden = true;
      setRoundRecap(this.#roundRecap());
      renderBoard(this.#standings());
    }
  }

  /**
   * The two columns either side of the board. Everything here is already
   * known to the render loop -- it was just never shown. Both renderers
   * diff against their last input, so a frame that changes nothing costs a
   * JSON.stringify and no DOM work.
   */
  #renderRails(visible) {
    const info = EVENTS[this.round.event];
    const mid = this.local.midModifierShown || this.round.mid_modifier_fired
      ? EVENTS[this.round.mid_modifier] : null;

    renderRailLeft({
      roundNo: this.round.round_no,
      totalRounds: this.room.total_rounds,
      guessesUsed: visible.length,
      maxGuesses: this.round.max_guesses,
      eventEmoji: info?.emoji ?? null,
      eventLabel: info?.label ?? null,
      midEmoji: mid?.emoji ?? null,
      midLabel: mid?.label ?? null,
    });

    const byId = new Map(this.leaderboard.map((r) => [r.player_id, r.total]));
    const perPlayer = new Map();
    for (const g of visible) perPlayer.set(g.player_id, (perPlayer.get(g.player_id) ?? 0) + 1);

    renderRailRight({
      mode: this.mode,
      maxGuesses: this.round.max_guesses,
      ghost: this.ghost ? {
        attempts: this.ghost.attempts, hits: this.ghost.hits ?? 0,
        solved: !!this.ghost.solved,
      } : null,
      rows: this.players.map((p) => ({
        name: p.name, color: p.color,
        isMe: p.id === this.me?.id,
        guesses: perPlayer.get(p.id) ?? 0,
        total: byId.get(p.id) ?? 0,
      })),
    });
  }

  #onPhaseChange(phase) {
    $('#room-scene')?.querySelector('.room-character')?.classList.toggle('is-typing', phase === 'live');
    music.set(this.musicTheme());

    // The room only comes alive while a round is actually being played, and
    // is torn down on the way out of every other phase -- otherwise a cat
    // that spawned at the end of a round wanders across the standings.
    if (phase === 'live') {
      this.stopRoomEvents?.();
      this.stopRoomEvents = startRoomEvents();
    } else if (this.stopRoomEvents) {
      this.stopRoomEvents();
      this.stopRoomEvents = null;
    }

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
      setRoundRecap(this.#roundRecap());
      renderBoard(this.#standings());
      showScreen('screen-board');
    } else if (phase === 'waiting') {
      setPhase('Waiting', null);
    } else if (phase === 'final') {
      this.#showFinal();
    }
  }
}
