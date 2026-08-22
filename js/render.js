// Canvas rendering. Draws whatever state the game loop hands it; holds no game
// state of its own beyond short-lived visual effects.

import { ARENA, BALL_RADIUS, CLOSE_PX } from './config.js';

export const BALL_COLORS = ['#4bd0ff', '#ff4d9d', '#ffd166'];
export const BALL_NAMES = ['Ball A', 'Ball B', 'Ball C'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.effects = [];
    this.flashes = [];
    this.shake = 0;
    this.scale = 1;
    this.resize();
    if (window.ResizeObserver) {
      new ResizeObserver(() => this.resize()).observe(canvas);
    } else {
      window.addEventListener('resize', () => this.resize());
    }
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.scale = this.canvas.width / ARENA.w;
  }

  /** Convert a pointer event into arena coordinates. */
  toArena(event) {
    const rect = this.canvas.getBoundingClientRect();
    const px = (event.clientX ?? 0) - rect.left;
    const py = (event.clientY ?? 0) - rect.top;
    return { x: (px / rect.width) * ARENA.w, y: (py / rect.height) * ARENA.h };
  }

  ping(x, y, color = '#ffffff') {
    this.effects.push({ x, y, color, born: performance.now(), life: 620 });
  }

  /** A bumper or wall hit: a bright ring plus a kick to the whole arena. */
  impact(x, y, speed, isBumper) {
    this.flashes.push({ x, y, born: performance.now(), life: isBumper ? 340 : 220, isBumper });
    this.shake = Math.min(9, this.shake + (isBumper ? 2.4 : 1.1) * Math.min(1, speed / 12));
  }

  draw(view) {
    const ctx = this.ctx;
    const now = performance.now();

    // Decay the shake, then offset the whole arena by a deterministic-ish
    // wobble. Purely cosmetic, so a cheap pseudo-random is fine here.
    this.shake *= 0.86;
    if (this.shake < 0.05) this.shake = 0;
    const sx = this.shake ? (Math.random() * 2 - 1) * this.shake : 0;
    const sy = this.shake ? (Math.random() * 2 - 1) * this.shake : 0;

    ctx.setTransform(this.scale, 0, 0, this.scale, sx * this.scale, sy * this.scale);
    ctx.clearRect(-20, -20, ARENA.w + 40, ARENA.h + 40);

    const inset = view.wallInset ?? 0;
    this.#floor(ctx, view);
    if (view.obstacles) this.#bumpers(ctx, view.obstacles, now);
    this.#walls(ctx, view, inset);

    if (view.sim) {
      if (view.showTrails) this.#trails(ctx, view.trails ?? view.sim.trails, view.ballsHidden);
      if (!view.ballsHidden && view.positions) {
        this.#balls(ctx, view.positions, view.sim.velocities(), now, view.calledBall, view.ghosted);
      } else if (view.ballsHidden) {
        this.#hiddenHint(ctx, now);
      }
    }

    this.#flashes(ctx, now);
    this.#effects(ctx, now);
    if (view.reveal) this.#reveal(ctx, view.reveal, now);
    if (view.marker) this.#marker(ctx, view.marker, now);
    if (view.dim) this.#dim(ctx, view.dim);
    if (view.guessRing != null) this.#guessRing(ctx, view.guessRing, inset);
  }

  // ── layers ───────────────────────────────────────────────────────────

  #floor(ctx, view) {
    ctx.fillStyle = '#080a16';
    ctx.fillRect(-20, -20, ARENA.w + 40, ARENA.h + 40);

    const g = ctx.createRadialGradient(ARENA.w / 2, ARENA.h / 2, 40, ARENA.w / 2, ARENA.h / 2, ARENA.w * 0.68);
    g.addColorStop(0, view.ballsHidden ? '#0d1024' : (view.tint ? this.#mix(view.tint) : '#131a38'));
    g.addColorStop(1, '#06070f');
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, ARENA.w + 40, ARENA.h + 40);

    ctx.strokeStyle = 'rgba(90,110,190,.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 60; x < ARENA.w; x += 60) { ctx.moveTo(x, 0); ctx.lineTo(x, ARENA.h); }
    for (let y = 60; y < ARENA.h; y += 60) { ctx.moveTo(0, y); ctx.lineTo(ARENA.w, y); }
    ctx.stroke();

    // The gravity well is invisible otherwise — draw what the ball is feeling.
    if (view.modifier === 'gravity') {
      const cx = ARENA.w / 2, cy = ARENA.h / 2;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 700);
      for (let i = 1; i <= 4; i++) {
        ctx.strokeStyle = `rgba(199,146,234,${0.16 - i * 0.028 + pulse * 0.05})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 34 * i + pulse * 10, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  #mix(tint) {
    // Nudge the floor toward the modifier's colour without washing it out.
    return tint + '2b';
  }

  #walls(ctx, view, inset) {
    const w = ARENA.wall;
    ctx.fillStyle = '#171c33';
    ctx.fillRect(-20, -20, ARENA.w + 40, w + inset + 20);
    ctx.fillRect(-20, ARENA.h - w - inset, ARENA.w + 40, w + inset + 20);
    ctx.fillRect(-20, -20, w + inset + 20, ARENA.h + 40);
    ctx.fillRect(ARENA.w - w - inset, -20, w + inset + 20, ARENA.h + 40);

    ctx.strokeStyle = view.ballsHidden ? 'rgba(255,77,157,.5)'
                    : (view.tint ? view.tint + 'aa' : 'rgba(75,208,255,.42)');
    ctx.lineWidth = 2;
    ctx.strokeRect(w + inset + 1, w + inset + 1,
                   ARENA.w - 2 * (w + inset) - 2, ARENA.h - 2 * (w + inset) - 2);
  }

  #bumpers(ctx, bumpers, now) {
    for (let i = 0; i < bumpers.length; i++) {
      const b = bumpers[i];
      const pulse = 0.5 + 0.5 * Math.sin(now / 900 + i * 1.7);
      if (b.kind === 'circle') {
        const g = ctx.createRadialGradient(b.x, b.y, b.r * 0.2, b.x, b.y, b.r);
        g.addColorStop(0, `rgba(139,125,255,${0.34 + pulse * 0.16})`);
        g.addColorStop(1, 'rgba(40,46,90,.92)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(160,150,255,${0.5 + pulse * 0.3})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(44,50,96,.94)';
        this.#roundRect(ctx, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, 7);
        ctx.fill();
        ctx.strokeStyle = `rgba(150,140,250,${0.42 + pulse * 0.26})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  #trails(ctx, trails, faded) {
    for (let i = 0; i < trails.length; i++) {
      const pts = trails[i];
      if (!pts || pts.length < 2) continue;
      const color = BALL_COLORS[i % BALL_COLORS.length];
      for (let j = 1; j < pts.length; j++) {
        const t = j / pts.length;
        ctx.strokeStyle = color;
        ctx.globalAlpha = (faded ? 0.1 : 0.32) * t * t;
        ctx.lineWidth = 1 + t * (BALL_RADIUS * 0.9);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(pts[j - 1].x, pts[j - 1].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  #balls(ctx, positions, velocities, now, calledBall, ghosted) {
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const color = BALL_COLORS[i % BALL_COLORS.length];
      const speed = Math.hypot(velocities[i].x, velocities[i].y);

      // Under `ghost` the ball blinks out on a fixed cadence. It is still there,
      // still bouncing — you just cannot see it.
      if (ghosted) {
        ctx.globalAlpha = 0.13;
        ctx.strokeStyle = color;
        ctx.setLineDash([3, 6]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, BALL_RADIUS + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        continue;
      }

      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, BALL_RADIUS * 4.2);
      glow.addColorStop(0, color);
      glow.addColorStop(0.22, `${color}66`);
      glow.addColorStop(1, 'transparent');
      ctx.globalAlpha = 0.5 + Math.min(0.35, speed / 40);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, BALL_RADIUS * 4.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.beginPath();
      ctx.arc(p.x - BALL_RADIUS * 0.28, p.y - BALL_RADIUS * 0.3, BALL_RADIUS * 0.34, 0, Math.PI * 2);
      ctx.fill();

      // Only worth labelling when there is more than one ball to confuse.
      if (positions.length > 1) {
        ctx.strokeStyle = i === calledBall ? '#ffffff' : `${color}88`;
        ctx.lineWidth = i === calledBall ? 2.5 : 1.5;
        ctx.setLineDash(i === calledBall ? [] : [4, 5]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, BALL_RADIUS + 8 + (i === calledBall ? Math.sin(now / 220) * 1.6 : 0), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#e8ecff';
        ctx.font = '700 12px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String.fromCharCode(65 + i), p.x, p.y - BALL_RADIUS - 13);
      }
    }
  }

  #hiddenHint(ctx, now) {
    // Scanline wash so a dark arena still reads as "running", not "crashed".
    ctx.globalAlpha = 0.06 + 0.03 * Math.sin(now / 260);
    ctx.fillStyle = '#ff4d9d';
    for (let y = ARENA.wall; y < ARENA.h - ARENA.wall; y += 4) {
      ctx.fillRect(ARENA.wall, y, ARENA.w - ARENA.wall * 2, 1);
    }
    ctx.globalAlpha = 1;
  }

  #flashes(ctx, now) {
    this.flashes = this.flashes.filter((f) => now - f.born < f.life);
    for (const f of this.flashes) {
      const t = (now - f.born) / f.life;
      ctx.globalAlpha = (1 - t) * (f.isBumper ? 0.7 : 0.4);
      ctx.strokeStyle = f.isBumper ? '#c792ea' : '#4bd0ff';
      ctx.lineWidth = (f.isBumper ? 3.5 : 2) * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 8 + t * (f.isBumper ? 52 : 30), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  #effects(ctx, now) {
    this.effects = this.effects.filter((e) => now - e.born < e.life);
    for (const e of this.effects) {
      const t = (now - e.born) / e.life;
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 3 * (1 - t) + 0.6;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 14 + t * 96, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  #marker(ctx, m, now) {
    const pulse = 1 + Math.sin(now / 200) * 0.08;
    ctx.strokeStyle = m.color || '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(m.x, m.y, 13 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(m.x - 21, m.y); ctx.lineTo(m.x - 5, m.y);
    ctx.moveTo(m.x + 5, m.y); ctx.lineTo(m.x + 21, m.y);
    ctx.moveTo(m.x, m.y - 21); ctx.lineTo(m.x, m.y - 5);
    ctx.moveTo(m.x, m.y + 5); ctx.lineTo(m.x, m.y + 21);
    ctx.stroke();
  }

  /** reveal = { truth: [{x,y}], guesses: [{x,y,ball,color,points,mine}] } */
  #reveal(ctx, reveal, now) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);

    for (const g of reveal.guesses) {
      const t = reveal.truth[g.ball];
      if (!t) continue;
      ctx.strokeStyle = g.color;
      ctx.globalAlpha = g.mine ? 0.85 : 0.42;
      ctx.lineWidth = g.mine ? 2 : 1.2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      ctx.fillStyle = g.color;
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.mine ? 8 : 6, 0, Math.PI * 2);
      ctx.fill();
      if (g.mine) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = '#e8ecff';
      ctx.font = `${g.mine ? 700 : 600} 12px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`+${g.points}`, g.x, g.y - 13);
    }

    for (let i = 0; i < reveal.truth.length; i++) {
      const t = reveal.truth[i];
      const color = BALL_COLORS[i % BALL_COLORS.length];
      // The "close enough" ring, so the threshold is something you can see.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.22 + pulse * 0.1;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(t.x, t.y, CLOSE_PX, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const glow = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, BALL_RADIUS * 4);
      glow.addColorStop(0, color);
      glow.addColorStop(0.25, `${color}55`);
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL_RADIUS * 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL_RADIUS + 5 + pulse * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  #dim(ctx, amount) {
    ctx.fillStyle = `rgba(4,5,12,${amount})`;
    ctx.fillRect(-20, -20, ARENA.w + 40, ARENA.h + 40);
  }

  /** Shrinking ring around the arena edge showing the 3s guess window. */
  #guessRing(ctx, fraction, inset) {
    const edge = ARENA.wall / 2 + inset;
    const w = ARENA.w - edge * 2;
    const h = ARENA.h - edge * 2;
    const perimeter = (w + h) * 2;
    ctx.strokeStyle = fraction < 0.34 ? '#ff4d9d' : '#ffd166';
    ctx.lineWidth = ARENA.wall;
    ctx.setLineDash([perimeter * Math.max(0, fraction), perimeter]);
    ctx.strokeRect(edge, edge, w, h);
    ctx.setLineDash([]);
  }

  #roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
