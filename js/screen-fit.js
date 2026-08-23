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
