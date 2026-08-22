// The shared deterministic simulation.
//
// Nothing about ball positions is ever sent over the wire. Each client gets the
// round's server-issued seed and modifier and rebuilds the identical arena from
// them, then walks a fixed 60Hz timestep. The only live input is the list of
// nudges, and each nudge carries the tick it applies on — so applying the same
// set of nudges to the same seed necessarily produces the same round everywhere.
//
// Everything here sticks to +, -, *, / and sqrt. Math.sin and friends are not
// guaranteed bit-identical across JS engines, so no modifier is allowed to use
// them; the periodic ones ride a triangle wave instead.

import {
  ARENA, BALL_RADIUS, DT_MS, BALL_SPEED_MIN, BALL_SPEED_MAX,
  NUDGE_SPEED, NUDGE_RANGE, GRAVITY_PULL, TURBO_SCALE,
  DRIFT_AMPLITUDE, DRIFT_PERIOD, SHRINK_MAX, GHOST_ON, GHOST_OFF,
} from './config.js';
import { makeRng, seedToInt32, rand } from './rng.js';

const { Engine, Bodies, Body, Composite, Events } = window.Matter;

/** Triangle wave in [-1, 1]; pure arithmetic, unlike Math.sin. */
function triangle(t, period) {
  const x = ((t % period) + period) % period / period;   // 0..1
  return x < 0.5 ? x * 4 - 1 : 3 - x * 4;
}

// A unit vector drawn from the seeded stream, built from a rejection sample
// rather than an angle so the only transcendental op involved is sqrt.
function unitVector(rng) {
  for (let i = 0; i < 24; i++) {
    const x = rng() * 2 - 1;
    const y = rng() * 2 - 1;
    const m2 = x * x + y * y;
    if (m2 > 0.05 && m2 <= 1) {
      const m = Math.sqrt(m2);
      return { x: x / m, y: y / m };
    }
  }
  return { x: 1, y: 0 };
}

/**
 * Derive the whole arena — 4 to 6 static obstacles plus the ball spawns — from
 * one integer seed.
 */
export function buildLayout(seed, ballCount) {
  const rng = makeRng(seedToInt32(seed));
  const inset = ARENA.wall + 62;
  const bumpers = [];
  const target = rand.int(rng, 4, 6);

  // Rejection sampling: keep obstacles clear of each other and of the walls, so
  // no layout ever boxes a ball into a corner it cannot escape.
  let guard = 0;
  while (bumpers.length < target && guard++ < 500) {
    const isCircle = rng() < 0.6;
    const cand = isCircle
      ? { kind: 'circle', r: rand.between(rng, 26, 48) }
      : { kind: 'block', w: rand.between(rng, 26, 150), h: rand.between(rng, 26, 150) };
    const halfW = isCircle ? cand.r : cand.w / 2;
    const halfH = isCircle ? cand.r : cand.h / 2;
    cand.x = rand.between(rng, inset + halfW, ARENA.w - inset - halfW);
    cand.y = rand.between(rng, inset + halfH, ARENA.h - inset - halfH);
    // Which way this obstacle slides under the `drift` modifier, and how far
    // out of phase it is with the others. Drawn from the seed either way so the
    // layout is identical whether or not the modifier is in play.
    cand.slide = unitVector(rng);
    cand.phase = Math.floor(rng() * DRIFT_PERIOD);

    const clashes = bumpers.some((b) => {
      const bw = b.kind === 'circle' ? b.r : b.w / 2;
      const bh = b.kind === 'circle' ? b.r : b.h / 2;
      return Math.abs(b.x - cand.x) < bw + halfW + 76
          && Math.abs(b.y - cand.y) < bh + halfH + 76;
    });
    if (!clashes) bumpers.push(cand);
  }

  // Spawn each ball near a different edge, aimed across the arena.
  const balls = [];
  const edges = [0, 1, 2, 3];
  for (let i = edges.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [edges[i], edges[j]] = [edges[j], edges[i]];
  }
  const margin = ARENA.wall + BALL_RADIUS + 26;
  for (let i = 0; i < ballCount; i++) {
    const edge = edges[i % edges.length];
    const along = rand.between(rng, 0.22, 0.78);
    let x, y, aim;
    if (edge === 0) { x = margin; y = ARENA.h * along; aim = { x: 1, y: 0 }; }
    else if (edge === 1) { x = ARENA.w - margin; y = ARENA.h * along; aim = { x: -1, y: 0 }; }
    else if (edge === 2) { x = ARENA.w * along; y = margin; aim = { x: 0, y: 1 }; }
    else { x = ARENA.w * along; y = ARENA.h - margin; aim = { x: 0, y: -1 }; }

    const jitter = unitVector(rng);
    const vx = aim.x * 0.75 + jitter.x * 0.55;
    const vy = aim.y * 0.75 + jitter.y * 0.55;
    const m = Math.sqrt(vx * vx + vy * vy) || 1;
    const speed = rand.between(rng, 7.5, 9.5);
    balls.push({ x, y, vx: (vx / m) * speed, vy: (vy / m) * speed });
  }

  return { bumpers, balls };
}

export class Sim {
  /** @param round a drift_rounds row: seed, ball_count, duration_ms, blackout_ms, modifier */
  constructor(round) {
    this.round = round;
    this.modifier = round.modifier ?? 'none';
    this.layout = buildLayout(round.seed, round.ball_count);
    this.liveTicks = Math.round(round.duration_ms / DT_MS);
    this.freezeTick = Math.round((round.duration_ms + round.blackout_ms) / DT_MS);
    this.nudges = new Map();   // player_id -> nudge
    this.schedule = new Map(); // tick -> nudge[]
    // Bumper hits worth a sound and a flash. Only collected while the
    // simulation is running live — a replay would otherwise re-fire hundreds.
    this.bounces = [];
    this.silent = false;
    this.build();
  }

  get speedMax() { return this.modifier === 'turbo' ? BALL_SPEED_MAX * TURBO_SCALE : BALL_SPEED_MAX; }
  get speedMin() { return this.modifier === 'turbo' ? BALL_SPEED_MIN * TURBO_SCALE : BALL_SPEED_MIN; }

  /** How far the walls have closed in by a given tick (`shrink` only). */
  wallInset(tick = this.tick) {
    if (this.modifier !== 'shrink') return 0;
    return SHRINK_MAX * Math.min(1, tick / Math.max(1, this.freezeTick));
  }

  /** Where an obstacle sits at a given tick (`drift` only). */
  obstacleAt(b, tick = this.tick) {
    if (this.modifier !== 'drift') return { x: b.x, y: b.y };
    const k = triangle(tick + b.phase, DRIFT_PERIOD) * DRIFT_AMPLITUDE;
    return { x: b.x + b.slide.x * k, y: b.y + b.slide.y * k };
  }

  /** Whether the ball is drawn on a given tick (`ghost` only). Visual only. */
  ghostVisible(tick = this.tick) {
    if (this.modifier !== 'ghost') return true;
    return ((tick % (GHOST_ON + GHOST_OFF)) < GHOST_ON);
  }

  build() {
    if (this.engine) Engine.clear(this.engine);
    const engine = Engine.create();
    engine.gravity.x = 0;
    engine.gravity.y = 0;      // top-down arena
    engine.enableSleeping = false;
    this.engine = engine;

    const w = ARENA.wall;
    this.walls = [
      Bodies.rectangle(ARENA.w / 2, w / 2, ARENA.w * 3, w, { isStatic: true }),
      Bodies.rectangle(ARENA.w / 2, ARENA.h - w / 2, ARENA.w * 3, w, { isStatic: true }),
      Bodies.rectangle(w / 2, ARENA.h / 2, w, ARENA.h * 3, { isStatic: true }),
      Bodies.rectangle(ARENA.w - w / 2, ARENA.h / 2, w, ARENA.h * 3, { isStatic: true }),
    ];
    for (const b of this.walls) { b.restitution = 1; b.friction = 0; b.frictionStatic = 0; }

    // Slightly super-elastic obstacles: every bumper hit adds a little energy,
    // which the per-tick speed clamp then bounds. That is what keeps a round
    // chaotic instead of gradually settling down.
    this.bumperBodies = this.layout.bumpers.map((b) => {
      const body = b.kind === 'circle'
        ? Bodies.circle(b.x, b.y, b.r, { isStatic: true })
        : Bodies.rectangle(b.x, b.y, b.w, b.h, { isStatic: true });
      body.restitution = 1.06;
      body.friction = 0;
      body.frictionStatic = 0;
      return body;
    });

    this.balls = this.layout.balls.map((s) => {
      const ball = Bodies.circle(s.x, s.y, BALL_RADIUS);
      ball.restitution = 1;
      ball.friction = 0;
      ball.frictionAir = 0;
      ball.frictionStatic = 0;
      Body.setInertia(ball, Infinity); // no spin: one less thing to diverge
      Body.setVelocity(ball, { x: s.vx, y: s.vy });
      return ball;
    });

    Composite.add(engine.world, [...this.walls, ...this.bumperBodies, ...this.balls]);

    // Purely cosmetic: drives the flash, the shake and the bounce blip.
    Events.on(engine, 'collisionStart', (e) => {
      if (this.silent) return;
      for (const pair of e.pairs) {
        const ball = this.balls.includes(pair.bodyA) ? pair.bodyA
                   : this.balls.includes(pair.bodyB) ? pair.bodyB : null;
        if (!ball) continue;
        const other = ball === pair.bodyA ? pair.bodyB : pair.bodyA;
        const speed = Math.sqrt(ball.velocity.x ** 2 + ball.velocity.y ** 2);
        this.bounces.push({
          x: ball.position.x, y: ball.position.y, speed,
          bumper: this.bumperBodies.includes(other),
        });
      }
    });

    this.tick = 0;
    this.trails = this.balls.map(() => []);
    // Snapshot of the trails at the instant the balls go dark. Rendering this
    // instead of the live trail during the blackout is what stops the tail from
    // quietly giving away where the ball went.
    this.lastSeen = null;
    // Positions one tick back, so the renderer can interpolate rather than
    // snapping the ball from tick to tick.
    this.prev = this.balls.map((b) => ({ x: b.position.x, y: b.position.y }));
  }

  rebuildSchedule() {
    this.schedule = new Map();
    // Sort by player id so two nudges landing on the same tick are always
    // applied in the same order, whichever order they arrived over the network.
    const all = [...this.nudges.values()].sort((a, b) =>
      a.apply_tick - b.apply_tick || String(a.player_id).localeCompare(String(b.player_id)));
    for (const n of all) {
      if (!this.schedule.has(n.apply_tick)) this.schedule.set(n.apply_tick, []);
      this.schedule.get(n.apply_tick).push(n);
    }
  }

  /**
   * Record a nudge. Returns true if it changed the simulation.
   * A nudge whose tick has already been stepped past forces a replay from tick
   * zero — the price of never having to trust anyone's reported positions.
   */
  addNudge(n) {
    const key = String(n.player_id);
    if (this.nudges.has(key)) return false; // one nudge per player, first wins
    this.nudges.set(key, { ...n, player_id: key });
    this.rebuildSchedule();
    if (n.apply_tick < this.tick) {
      const was = this.tick;
      this.build();
      this.silent = true;
      this.advanceTo(was);
      this.silent = false;
    }
    return true;
  }

  /**
   * Resolve a nudge at the tick it lands on. The stored click point — not a
   * direction baked in when the player clicked — is what makes this feel
   * accurate: the shove always pushes the ball directly away from the spot that
   * was clicked, however far the ball has travelled since.
   */
  applyNudge(n) {
    const ball = this.balls[n.ball_index];
    if (!ball) return;
    let dx = ball.position.x - n.click_x;
    let dy = ball.position.y - n.click_y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) { dx = 1; dy = 0; }
    else { dx /= d; dy /= d; }
    const strength = Math.max(0.18, Math.min(1, 1 - d / NUDGE_RANGE));
    const boost = NUDGE_SPEED * strength;
    Body.setVelocity(ball, {
      x: ball.velocity.x + dx * boost,
      y: ball.velocity.y + dy * boost,
    });
  }

  applyGravityWell() {
    const cx = ARENA.w / 2;
    const cy = ARENA.h / 2;
    for (const ball of this.balls) {
      const dx = cx - ball.position.x;
      const dy = cy - ball.position.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) continue;
      Body.setVelocity(ball, {
        x: ball.velocity.x + (dx / d) * GRAVITY_PULL,
        y: ball.velocity.y + (dy / d) * GRAVITY_PULL,
      });
    }
  }

  moveWalls() {
    const inset = this.wallInset();
    const w = ARENA.wall;
    Body.setPosition(this.walls[0], { x: ARENA.w / 2, y: w / 2 + inset });
    Body.setPosition(this.walls[1], { x: ARENA.w / 2, y: ARENA.h - w / 2 - inset });
    Body.setPosition(this.walls[2], { x: w / 2 + inset, y: ARENA.h / 2 });
    Body.setPosition(this.walls[3], { x: ARENA.w - w / 2 - inset, y: ARENA.h / 2 });
  }

  moveObstacles() {
    for (let i = 0; i < this.bumperBodies.length; i++) {
      Body.setPosition(this.bumperBodies[i], this.obstacleAt(this.layout.bumpers[i]));
    }
  }

  clampSpeeds() {
    const lo = this.speedMin;
    const hi = this.speedMax;
    for (const ball of this.balls) {
      const { x, y } = ball.velocity;
      const speed = Math.sqrt(x * x + y * y);
      if (speed < 1e-6) {
        Body.setVelocity(ball, { x: lo, y: 0 });
      } else if (speed < lo) {
        const k = lo / speed;
        Body.setVelocity(ball, { x: x * k, y: y * k });
      } else if (speed > hi) {
        const k = hi / speed;
        Body.setVelocity(ball, { x: x * k, y: y * k });
      }
    }
  }

  step() {
    this.prev = this.balls.map((b) => ({ x: b.position.x, y: b.position.y }));

    const due = this.schedule.get(this.tick);
    if (due) for (const n of due) this.applyNudge(n);
    if (this.modifier === 'gravity') this.applyGravityWell();
    if (this.modifier === 'shrink') this.moveWalls();
    if (this.modifier === 'drift') this.moveObstacles();

    Engine.update(this.engine, DT_MS);
    this.clampSpeeds();
    this.tick++;

    for (let i = 0; i < this.balls.length; i++) {
      const t = this.trails[i];
      t.push({ x: this.balls[i].position.x, y: this.balls[i].position.y });
      if (t.length > 26) t.shift();
    }
    if (this.tick === this.liveTicks) this.lastSeen = this.trails.map((t) => t.slice());
  }

  advanceTo(target) {
    const capped = Math.min(target, this.freezeTick);
    if (capped < this.tick) this.build();
    // Catching up more than a few ticks at once means the tab was backgrounded
    // or a nudge forced a replay. Either way the intervening bounces already
    // happened as far as the player is concerned, so do not replay the noise.
    const restore = this.silent;
    if (capped - this.tick > 4) this.silent = true;
    // A whole round is ~500 ticks, so even a replay from zero is a few
    // milliseconds. The cap is pure paranoia against a pathological clock.
    let budget = 4000;
    while (this.tick < capped && budget-- > 0) this.step();
    this.silent = restore;
  }

  /** Take and clear the bounces collected since the last frame. */
  drainBounces() {
    if (!this.bounces.length) return [];
    const out = this.bounces;
    this.bounces = [];
    return out;
  }

  positions() {
    return this.balls.map((b) => ({ x: b.position.x, y: b.position.y }));
  }

  /**
   * Positions blended `alpha` of the way from the previous tick to the current
   * one. The physics only ever sees whole ticks; this is what stops the ball
   * from stuttering on a display that does not happen to run at 60Hz.
   */
  interpolated(alpha) {
    const a = Math.max(0, Math.min(1, alpha));
    return this.balls.map((b, i) => {
      const p = this.prev[i] ?? b.position;
      return {
        x: p.x + (b.position.x - p.x) * a,
        y: p.y + (b.position.y - p.y) * a,
      };
    });
  }

  velocities() {
    return this.balls.map((b) => ({ x: b.velocity.x, y: b.velocity.y }));
  }

  /** Obstacle positions right now, which `drift` moves around. */
  obstacles() {
    return this.layout.bumpers.map((b) => ({ ...b, ...this.obstacleAt(b) }));
  }
}
