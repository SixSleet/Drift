// Keeps the flat app overlay sitting exactly on the monitor's screen.
//
// The room is real CSS 3D, and the monitor stands at z = -900, so perspective
// scales it to about 67%. Anything rendered *inside* that transform is
// rasterised at its layout size and then scaled down, which is exactly what
// made every letter on the screen look soft. Text does not survive that.
//
// So the app is not inside the 3D stage at all. `.monitor-screen` is left as
// a transparent hole, and the overlay is positioned behind the stage at the
// hole's measured on-screen rectangle -- flat, unscaled, snapped to whole
// pixels. The bezel, the glass and anything nearer the camera (the cat) are
// still in the stage, so they keep drawing over the top of it.
//
// The monitor is face-on (no rotateY), so the hole is always an axis-aligned
// rectangle and a plain left/top/width/height fit is exact.

/** Panel height under which the title screen tightens up. */
const SHORT_PANEL_PX = 545;

/**
 * The viewport the room is drawn for. Zoom is the smaller of how the real
 * viewport compares to this on each axis, so the scene always fits both.
 *
 * This replaced a ladder of media queries, which could not express that
 * idea: it grew the room on WIDTH alone (min-width: 1800px -> 1.18) and
 * shrank it on HEIGHT alone (max-height: 860px -> .86), with nothing tying
 * the two together. A 1080p monitor with the browser NOT full screen is
 * about 1920x990 -- wide enough to trigger the 1.18, tall enough to miss
 * every shrink rule -- so the room was drawn 18% too big for the height it
 * had and the top of the monitor went off the top of the window. It only
 * looked right full screen, which is exactly the report.
 */
const REF_W = 1600;
const REF_H = 900;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.2;

/**
 * Cover the width as well, so a very wide window never shows past the edge
 * of the room into flat background. On a 16:9 or 16:10 window the fit is
 * always the binding constraint and this does nothing; it only bites on
 * super-ultrawides, where being able to see the room's seams is the worse
 * of the two problems.
 */
const ROOM_W = 3150;

let lastZoom = null;

function fitRoom(flat) {
  const rooms = document.querySelectorAll('.room');
  if (flat) {
    // The flat layout sets its own zoom in the stylesheet (the front room
    // drops to .34 on a phone). An inline value would beat it, so clear it.
    if (lastZoom !== 'flat') {
      lastZoom = 'flat';
      rooms.forEach((r) => r.style.removeProperty('--zoom'));
    }
    return;
  }
  const fit = Math.min(window.innerWidth / REF_W, window.innerHeight / REF_H);
  const cover = window.innerWidth / ROOM_W;
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fit, cover)).toFixed(3);
  if (zoom === lastZoom) return;
  lastZoom = zoom;
  rooms.forEach((r) => r.style.setProperty('--zoom', zoom));
}

const screenEl = () => document.getElementById('monitor-screen');
const overlayEl = () => document.getElementById('app-overlay');

let last = '';

function fit() {
  const scr = screenEl();
  const app = overlayEl();
  if (!scr || !app) return;

  // In the flat fallback the room is gone and the overlay just fills the
  // viewport, which the stylesheet already handles -- don't fight it.
  const flat = getComputedStyle(document.getElementById('room-scene')).perspective === 'none';
  fitRoom(flat);
  if (flat) {
    if (last !== 'flat') {
      last = 'flat';
      app.style.cssText = '';
      app.classList.remove('is-short');
    }
    return;
  }

  const r = scr.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;

  // Round outward, so the overlay never leaves a sub-pixel seam of bezel
  // showing through along an edge.
  const left = Math.floor(r.left);
  const top = Math.floor(r.top);
  const width = Math.ceil(r.right) - left;
  const height = Math.ceil(r.bottom) - top;

  const key = `${left}:${top}:${width}:${height}`;
  if (key === last) return;
  last = key;

  app.style.left = `${left}px`;
  app.style.top = `${top}px`;
  app.style.width = `${width}px`;
  app.style.height = `${height}px`;
  // The tile grid sizes itself against the panel's real height (see
  // --tile in app.css), which only this module knows.
  app.style.setProperty('--panel-h', `${height}px`);
  // ...and so does the title screen, which is the tallest thing in the app.
  // On a small display the monitor shrinks with the viewport and the title
  // stack stops fitting -- it has always been scrollable, but a primary
  // button you have to scroll to find is a button nobody presses. Below
  // this the screen drops its decoration rather than its actions.
  app.classList.toggle('is-short', height < SHORT_PANEL_PX);
}

export function startScreenFit() {
  fit();
  // The hole moves whenever the room is re-laid-out: viewport resize, a zoom
  // breakpoint, fonts finishing. A ResizeObserver on the screen catches the
  // size changes; resize covers the rest.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(fit);
    const scr = screenEl();
    if (scr) ro.observe(scr);
    ro.observe(document.documentElement);
  }
  window.addEventListener('resize', fit, { passive: true });
  document.fonts?.ready.then(fit).catch(() => {});
  // One more pass after first paint: the 3D stage settles a frame late.
  requestAnimationFrame(() => requestAnimationFrame(fit));
}
