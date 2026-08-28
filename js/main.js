// Bootstrap: wire the buttons to the game, and nothing else.

import { Game } from './game.js';
import { startScreenFit } from './screen-fit.js';
import { DEFAULT_ROUNDS, DEFAULT_WORD_LENGTH, WORD_LENGTH_CHOICES } from './config.js';
import { sfx } from './sfx.js';
import {
  $, showScreen, toast, buildKeypad, setCodeDisplay, flashKey, setMuteButton,
  chipGroup, showError, CODE_ALPHABET, buildSettings, confirmDialog,
} from './ui.js';
import { volume } from './audio.js';
import { GAMES, startArcade, stopArcade, bestScore } from './arcade.js';
import { music, tracks } from './music.js';
import {
  LANGUAGES, getLang, setLang, t, applyTranslations, modeLabel, modeBlurb, foldKey,
} from './i18n.js';

const game = new Game();
// Exposed so the browser test harness can inspect the live simulation.
window.__wordforge = game;
let chosenMode = 'solo';
let chosenRounds = DEFAULT_ROUNDS;
let chosenWordLength = DEFAULT_WORD_LENGTH;   // null = mixed
let codeBuffer = '';

function fail(err) {
  const msg = String(err?.message ?? err);
  const onCode = (key) => {
    showScreen('screen-code');
    $('#code-note').textContent = t(key);
    codeBuffer = '';
    setCodeDisplay('');
  };
  if (/no such room/i.test(msg)) { onCode('code.noRoom'); return; }
  if (/already started/i.test(msg)) { onCode('code.started'); return; }
  if (/room is full/i.test(msg)) { onCode('code.full'); return; }
  showError(t('error.title'), msg);
}

// ── Title ──────────────────────────────────────────────────────────────

function setCreateLabel(mode) {
  $('#btn-create').textContent = t(mode === 'solo' ? 'btn.playSolo' : 'btn.createRoomShort');
}
setCreateLabel(chosenMode);

chipGroup($('#mode-chips'), (v) => { chosenMode = v; setCreateLabel(v); }, 'mode');

// The three mode chips are written out in index.html so the title screen has
// something to show before any script runs; their text is replaced here, and
// again whenever the language changes.
function paintModeChips() {
  for (const b of $('#mode-chips').children) {
    const m = b.dataset.mode;
    b.querySelector('.mode-name').textContent = modeLabel(m);
    b.querySelector('.mode-blurb').textContent = modeBlurb(m);
  }
  setCreateLabel(chosenMode);
}
chipGroup($('#rounds-chips'), (v) => { chosenRounds = Number(v); }, 'rounds');

// Word length is fixed for the whole match and has to be settled before the
// room exists, since wf_create_room stores it on the room -- joiners inherit
// it and never get a say.
(function buildWordLengthChips() {
  const box = $('#length-chips');
  if (!box) return;
  const key = (v) => (v === null ? 'mixed' : String(v));
  for (const c of WORD_LENGTH_CHOICES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.dataset.length = key(c.value);
    // The numbers are the same in every language; only Mixed and the hints
    // need translating, so only those go through the table.
    b.textContent = c.value === null ? t('length.mixed') : c.label;
    if (c.value === null) b.dataset.i18n = 'length.mixed';
    b.dataset.i18nTitle = `length.${key(c.value)}.hint`;
    b.title = t(b.dataset.i18nTitle);
    if (c.value === DEFAULT_WORD_LENGTH) b.classList.add('is-on');
    box.appendChild(b);
  }
  const hint = $('#length-hint');
  const describe = (v) => t(`length.${key(v)}.hint`);
  const paintHint = () => { if (hint) hint.textContent = describe(chosenWordLength); };
  paintHint();
  chipGroup(box, (v) => {
    chosenWordLength = v === 'mixed' ? null : Number(v);
    paintHint();
  }, 'length');
  // Chip titles and the hint under them are derived, so they have to be
  // repainted when the language changes -- applyTranslations only knows
  // about static data-i18n text.
  window.addEventListener('wf-lang', () => {
    for (const b of box.children) b.title = t(b.dataset.i18nTitle);
    paintHint();
  });
})();

$('#btn-create').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await game.createRoom(chosenMode, chosenRounds, chosenWordLength); }
  catch (err) { fail(err); }
  finally { e.target.disabled = false; }
});

$('#btn-join').addEventListener('click', () => {
  codeBuffer = '';
  setCodeDisplay('');
  $('#code-note').textContent = '';
  showScreen('screen-code');
});

// ── Code entry: tap the pad or type on a real keyboard — both call this ──

async function submitCode() {
  $('#code-note').textContent = t('code.joining');
  try { await game.joinRoom(codeBuffer); }
  catch (err) { fail(err); }
}

function enterChar(ch) {
  if (codeBuffer.length >= 4 || !CODE_ALPHABET.includes(ch)) return;
  codeBuffer += ch;
  setCodeDisplay(codeBuffer);
  flashKey(ch);
  if (codeBuffer.length === 4) submitCode();
}

function deleteChar() {
  codeBuffer = codeBuffer.slice(0, -1);
  setCodeDisplay(codeBuffer);
  $('#code-note').textContent = '';
}

buildKeypad(enterChar);
$('#btn-code-del').addEventListener('click', deleteChar);
$('#btn-code-back').addEventListener('click', () => showScreen('screen-title'));

// A physical keyboard does the same thing a tap does on the code screen: any
// key on the pad enters that character, Backspace deletes, and browser
// shortcuts (anything held with Ctrl/Alt/Meta) are left alone.
document.addEventListener('keydown', (e) => {
  if (!$('#screen-code[data-active]')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest?.('input, select, textarea, .settings-panel')) return;
  if (e.key === 'Backspace') { e.preventDefault(); deleteChar(); return; }
  const ch = e.key.length === 1 ? e.key.toUpperCase() : '';
  if (ch && CODE_ALPHABET.includes(ch)) { e.preventDefault(); enterChar(ch); }
});

// ── Lobby ──────────────────────────────────────────────────────────────

$('#btn-start').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await game.startGame(); }
  catch (err) { toast(String(err.message || err)); e.target.disabled = false; }
});

// ── Leaving, and renaming ──────────────────────────────────────────────

function backToMenu() {
  // A fresh load rather than showScreen('screen-title'): the game object
  // holds a room's worth of state, and half-clearing it is how you end up
  // joining your next room with the last one's leftovers.
  location.href = location.pathname;
}

async function leave(btn) {
  if (btn) btn.disabled = true;
  try { await game.leave(); }
  catch (err) { toast(String(err.message || err)); }
  backToMenu();
}

// Both ask, because both are one click from throwing away something you
// cannot get back into -- but they are different sizes of mistake, so they
// are different questions.
$('#btn-leave-lobby')?.addEventListener('click', async (e) => {
  const ok = await confirmDialog({
    title: t('leave.roomTitle'),
    body: game.isHost && game.players.length > 1
      ? t('leave.roomHost') : t('leave.roomBody'),
    confirm: t('btn.leave'), cancel: t('btn.stay'),
  });
  if (ok) leave(e.currentTarget);
});
$('#btn-leave-game')?.addEventListener('click', async (e) => {
  const ok = await confirmDialog({
    title: t('leave.title'),
    body: t('leave.body'),
    confirm: t('btn.leave'), cancel: t('btn.keepPlaying'),
  });
  if (ok) leave(e.currentTarget);
});

const renameRow = $('#rename-row');
const renameInput = $('#rename-input');

function showRename(show) {
  if (!renameRow) return;
  renameRow.hidden = !show;
  $('#btn-rename').hidden = show;
  if (show) {
    renameInput.value = game.me?.name ?? '';
    renameInput.focus();
    renameInput.select();
  }
}

$('#btn-rename')?.addEventListener('click', () => showRename(true));
$('#btn-rename-cancel')?.addEventListener('click', () => showRename(false));
renameRow?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const wanted = renameInput.value;
  const save = $('#btn-rename-save');
  save.disabled = true;
  try {
    const got = await game.rename(wanted);
    // The server strips what it will not render, so tell them if what they
    // get back is not what they typed.
    if (got !== wanted.trim()) toast(t('toast.savedAs', { name: got }));
    showRename(false);
  } catch (err) {
    const msg = String(err.message || err);
    toast(/empty/i.test(msg) ? t('toast.emptyName') : msg);
  } finally {
    save.disabled = false;
  }
});
// The lobby is a screen with a text input on it, so the code-entry and game
// key listeners must not see anything typed in here.
renameRow?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { showRename(false); return; }
  e.stopPropagation();
});

$('#btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast(t('toast.linkCopied'));
  } catch {
    toast(location.href, 6000);
  }
});

// ── Game ───────────────────────────────────────────────────────────────

setMuteButton(sfx.muted);

// The HUD icon and the panel's button are two views of one mute, so each has
// to repaint the other -- otherwise muting from the panel leaves a speaker
// icon in the HUD claiming sound is on.
const settings = buildSettings(
  { music: volume.music, sfx: volume.sfx, muted: volume.muted },
  {
    onMusic: (v) => volume.setMusic(v),
    onSfx: (v) => {
      volume.setSfx(v);
      sfx.type();          // so you can hear what you just set
    },
    onMute: () => {
      const muted = sfx.toggleMute();
      setMuteButton(muted);
      return muted;
    },
  },
);

$('#btn-mute').addEventListener('click', () => {
  const muted = sfx.toggleMute();
  setMuteButton(muted);
  settings?.paintMute(muted);
});

// Guesses are physical-keyboard only -- there's no on-screen keyboard to
// tap. This listener only fires while the game screen is showing, so it
// never fights the code-entry listener above or fires during lobby/board.
document.addEventListener('keydown', (e) => {
  if (!$('#screen-game[data-active]')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  // A focused slider owns its own arrow keys, and a letter typed with one
  // focused must not do both things at once. The panel stops propagation
  // itself; this is the backstop for any control added later.
  if (e.target.closest?.('input, select, textarea, .settings-panel')) return;
  if (e.key === 'Enter') { e.preventDefault(); game.handleKey('ENTER'); return; }
  if (e.key === 'Backspace') { e.preventDefault(); game.handleKey('BACK'); return; }
  // é, ñ, ü and the rest land as the letter underneath them, because that is
  // how the word lists store them -- see foldKey.
  const ch = e.key.length === 1 ? foldKey(e.key) : null;
  if (ch) { e.preventDefault(); game.handleKey(ch); }
});

// ── The jukebox ────────────────────────────────────────────────────────
//
// Every theme in the game, playable from the main menu. It holds the music
// the same way the arcade does -- an override taken by name -- so handing it
// back cannot cancel somebody else's takeover, and so the moment you leave
// the menu the game's own music is exactly what it would have been.

const juke = {
  panel: $('#jukebox-panel'),
  list: $('#jukebox-list'),
  held: null,
  poll: null,
};

if (juke.panel) {
  for (const track of tracks()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jukebox-track';
    b.dataset.track = track.id;
    b.innerHTML = '<span></span><span class="jukebox-bpm"></span>';
    b.firstChild.textContent = track.name;
    b.lastChild.textContent = `${track.bpm}`;
    b.addEventListener('click', () => {
      // Starting audio needs a gesture, and this is one -- so a player who
      // has not clicked anything else yet still gets sound out of it.
      if (!music.running) music.start(game.musicTheme());
      juke.held = track.id;
      music.cue(track.id);
      paintJukebox();
    });
    juke.list.appendChild(b);
  }
}

/** Mark which track is playing, and which is still waiting for the bar. */
function paintJukebox() {
  if (!juke.panel || juke.panel.hidden) return;
  const playing = music.running ? music.theme : null;
  const wanted = music.running ? music.target : null;
  for (const b of juke.list.children) {
    const id = b.dataset.track;
    const state = id === playing && id === wanted ? 'playing'
      : id === wanted ? 'cued'
      : '';
    if (state) b.dataset.state = state; else delete b.dataset.state;
  }
}

function showJukebox(show) {
  if (!juke.panel) return;
  juke.panel.hidden = !show;
  $('#btn-jukebox')?.setAttribute('aria-expanded', String(show));
  clearInterval(juke.poll);
  juke.poll = null;
  if (show) {
    paintJukebox();
    // The engine has no "theme changed" event -- it swaps inside the audio
    // scheduler -- so the panel watches instead. Only while it is open.
    juke.poll = setInterval(paintJukebox, 200);
  }
}

$('#btn-jukebox')?.addEventListener('click', () => showJukebox(juke.panel.hidden));
$('#btn-jukebox-close')?.addEventListener('click', () => showJukebox(false));
// Clicking the backdrop closes it, same as the confirm dialog. Without this
// the only way out is a small x, and the card covers the menu behind it.
juke.panel?.addEventListener('mousedown', (e) => { if (e.target === juke.panel) showJukebox(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && juke.panel && !juke.panel.hidden) { e.stopPropagation(); showJukebox(false); }
}, true);
$('#btn-jukebox-stop')?.addEventListener('click', () => {
  if (juke.held) { music.release(juke.held); juke.held = null; }
  paintJukebox();
});
// Opening the arcade from the menu hands the music straight over to it.
$('#btn-arcade-title')?.addEventListener('click', () => {
  if (juke.held) { music.release(juke.held); juke.held = null; }
  showJukebox(false);
});

// ── Arcade ─────────────────────────────────────────────────────────────
//
// The two entry points are the two places you wait: the title screen, and
// the lobby with a room code up and nobody in it yet. `cameFrom` is where
// Back goes, so leaving the arcade from a lobby returns to that lobby
// rather than dumping you at the title with a room still open.

let cameFrom = 'screen-title';

(function buildArcadePicker() {
  const box = $('#arcade-picker');
  if (!box) return;
  for (const [id, g] of Object.entries(GAMES)) {
    const b = document.createElement('button');
    b.className = 'chip mode-chip';
    b.type = 'button';
    b.dataset.arcade = id;
    b.innerHTML = `<span class="mode-name"></span><span class="mode-blurb"></span><span class="arcade-chip-best"></span>`;
    b.querySelector('.mode-name').dataset.i18n = g.nameKey;
    b.querySelector('.mode-blurb').dataset.i18n = g.blurbKey;
    b.addEventListener('click', () => play(id));
    box.appendChild(b);
  }
  applyTranslations(box);
  window.addEventListener('wf-lang', () => applyTranslations(box));
})();

// Which arcade theme currently holds the override, so it can be handed back
// by name. music.release() with no name releases whoever holds it, and the
// storm can be the holder -- releasing it from here would silence a storm
// that is still raining on someone's window.
let arcadeHeld = null;
function holdArcade(name) { arcadeHeld = name; music.override(name); }
function releaseArcade() { if (arcadeHeld) { music.release(arcadeHeld); arcadeHeld = null; } }

function paintArcadeBests() {
  for (const [id] of Object.entries(GAMES)) {
    const chip = $(`#arcade-picker .chip[data-arcade="${id}"] .arcade-chip-best`);
    if (!chip) continue;
    const best = bestScore(id);
    chip.textContent = best
      ? t('arcade.bestUnit', { n: best, unit: t(GAMES[id].unitKey) })
      : t('arcade.notPlayed');
  }
}

function showPicker() {
  stopArcade();
  $('#arcade-picker').hidden = false;
  $('#arcade-stage').hidden = true;
  $('#arcade-time').hidden = true;
  $('#arcade-score').parentElement.hidden = true;
  $('#arcade-title').textContent = t('arcade.warmUp');
  paintArcadeBests();
}

// Each game gets its own theme. They are three different kinds of pressure
// -- sixty seconds rummaging through a rack, a chain you must not break, and
// a moth you have three lives to hit -- and one shared bed made them feel
// like one game with three skins. `arcade_<id>` by convention, falling back
// to the picker's bed if a game is ever added without one.
const arcadeTheme = (id) => (music.knows(`arcade_${id}`) ? `arcade_${id}` : 'arcade');

async function play(id) {
  $('#arcade-picker').hidden = true;
  $('#arcade-stage').hidden = false;
  $('#arcade-time').hidden = false;
  $('#arcade-score').parentElement.hidden = false;
  // Still an override, and still released by the same paths -- the arcade
  // owns the music from the moment you open it until you leave, and which
  // theme is playing inside that is its own business.
  holdArcade(arcadeTheme(id));
  await startArcade(id, () => {
    // When a run ends, drop back to the picker so the score sits next to
    // the option to go again -- and back to the picker's own theme with it.
    $('#arcade-picker').hidden = false;
    $('#arcade-stage').hidden = true;
    $('#arcade-time').hidden = true;
    holdArcade('arcade');
    paintArcadeBests();
  });
}

function openArcade(from) {
  cameFrom = from;
  const note = $('#arcade-lobby-note');
  if (note) {
    // In a lobby the one thing you must not miss is people arriving, so the
    // count comes with you.
    note.hidden = from !== 'screen-lobby';
    if (from === 'screen-lobby') note.textContent = t('arcade.lobbyNote');
  }
  $('#arcade-result').hidden = true;
  showScreen('screen-arcade');
  showPicker();
  // The arcade gets its own bed. It sits between two menus and is the one
  // place here you are meant to be going fast; the title theme undercuts
  // that. Same key, so coming back out is not a lurch.
  holdArcade('arcade');
}

$('#btn-arcade-title')?.addEventListener('click', () => openArcade('screen-title'));
$('#btn-arcade-lobby')?.addEventListener('click', () => openArcade('screen-lobby'));
$('#btn-arcade-back')?.addEventListener('click', () => {
  stopArcade();
  releaseArcade();
  showScreen(cameFrom);
});

// A round starting has to win over whatever is on the arcade stage: game.js
// switches to the game screen by itself, but the arcade's key listener and
// its spawn timers would carry on underneath. Watching the screen rather
// than hooking the phase keeps this true for every route into the game.
new MutationObserver(() => {
  // The jukebox belongs to the main menu and nowhere else, so leaving that
  // screen closes it and hands the music back. Everything from the lobby
  // onwards then plays whatever the game says it should, untouched.
  if (!$('#screen-title[data-active]')) {
    showJukebox(false);
    if (juke.held) { music.release(juke.held); juke.held = null; }
  }
  if ($('#screen-arcade[data-active]')) return;
  stopArcade();
  // A round starting is also the arcade's music ending. Released by the name
  // it was taken under, because by now that could be any of the four arcade
  // themes -- and because an unnamed release would hand back whatever holds
  // the override, which during a live round can be the storm.
  releaseArcade();
}).observe($('#app'), { attributes: true, attributeFilter: ['data-active'], subtree: true });

$('#btn-again').addEventListener('click', () => { location.href = location.pathname; });
$('#btn-error-back').addEventListener('click', () => { location.href = location.pathname; });

// ── Language ───────────────────────────────────────────────────────────
//
// One row of flags on the title screen. Picking one rewrites every string
// carrying a data-i18n attribute, then fires `wf-lang` so the parts of the
// UI built in JavaScript (mode chips, length hints, the arcade picker) can
// repaint themselves too.
//
// It is only offered on the title screen, and only matters there: the word
// language is fixed onto a room when the room is created (see
// game.createRoom), so changing it mid-match would swap your menus without
// swapping the words -- confusing, and not what anyone means by it.

(function buildLanguageChips() {
  const box = $('#lang-chips');
  if (!box) return;
  for (const l of LANGUAGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip lang-chip';
    b.dataset.lang = l.code;
    b.innerHTML = '<span class="lang-flag"></span><span class="lang-name"></span>';
    b.firstChild.textContent = l.flag;
    b.lastChild.textContent = l.label;
    b.classList.toggle('is-on', l.code === getLang());
    b.addEventListener('click', () => {
      setLang(l.code);
      for (const other of box.children) other.classList.toggle('is-on', other === b);
      sfx.type();
    });
    box.appendChild(b);
  }
})();

// Static text first, then everything derived from it. Both again on a change.
function paintLanguage() {
  applyTranslations();
  paintModeChips();
  paintArcadeBests();
}
document.documentElement.lang = getLang();
paintLanguage();
window.addEventListener('wf-lang', paintLanguage);

// ── Go ─────────────────────────────────────────────────────────────────

// A browser will not let audio start before a gesture, so the soundtrack
// cannot begin on load -- it begins the first time the player touches
// anything. `once` because after that the game drives the theme itself.
for (const evt of ['pointerdown', 'keydown']) {
  document.addEventListener(evt, () => music.start(game.musicTheme()), { once: true });
}

startScreenFit();

(async () => {
  try {
    await game.boot();
    const code = new URL(location.href).searchParams.get('r');
    if (code && /^[A-Z2-9]{4}$/.test(code.toUpperCase())) {
      codeBuffer = code.toUpperCase();
      setCodeDisplay(codeBuffer);
      showScreen('screen-code');
      await submitCode();
    }
  } catch (err) {
    fail(err);
  }
})();
