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

const screenEl = () => document.getElementById('monitor-screen');
const overlayEl = () => document.getElementById('app-overlay');

let last = '';

function fit() {
  const scr = screenEl();
  const app = overlayEl();
  if (!scr || !app) return;

  // In the flat fallback the room is gone and the overlay just fills the
  // viewport, which the stylesheet already handles -- don't fight it.
  if (getComputedStyle(document.getElementById('room-scene')).perspective === 'none') {
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

/**
 * The consumer unit hangs under the shelf on the back wall.
 *
 * It cannot simply BE on the back wall, because during a power cut it has
 * to be the one thing still visible -- and the blackout sits above the whole
 * room. So it lives in the front layer, flat, and is pinned here to the spot
 * on the wall where it belongs.
 *
 * Under the shelf rather than on a side wall because at 16:9 the side walls
 * are entirely out of frame (see .wall-left): there is no right wall to
 * hang it on at the resolution most people are using.
 */
function fitFuseBox() {
  const box = document.getElementById('fusebox');
  const shelf = document.querySelector('.shelf');
  if (!box || !shelf) return;

  const room = document.getElementById('room-scene');
  if (room && getComputedStyle(room).perspective === 'none') {
    // Flat fallback: no room, no wall, nothing to hang it from.
    box.style.display = 'none';
    return;
  }
  box.style.display = '';

  const r = shelf.getBoundingClientRect();
  if (r.width < 2) return;
  // Sized off the shelf so it stays in proportion as the room zooms, and
  // centred under it with a gap that reads as wall.
  const width = Math.round(Math.max(46, Math.min(96, r.width * 0.24)));
  box.style.width = `${width}px`;
  box.style.left = `${Math.round(r.left + r.width / 2 - width / 2)}px`;
  box.style.top = `${Math.round(r.bottom + r.height * 0.42)}px`;
  box.style.right = 'auto';
}

export function startScreenFit() {
  fit();
  fitFuseBox();
  // The hole moves whenever the room is re-laid-out: viewport resize, a zoom
  // breakpoint, fonts finishing. A ResizeObserver on the screen catches the
  // size changes; resize covers the rest.
  const both = () => { fit(); fitFuseBox(); };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(both);
    const scr = screenEl();
    if (scr) ro.observe(scr);
    ro.observe(document.documentElement);
  }
  window.addEventListener('resize', both, { passive: true });
  document.fonts?.ready.then(both).catch(() => {});
  // One more pass after first paint: the 3D stage settles a frame late.
  requestAnimationFrame(() => requestAnimationFrame(both));
}
