// The shared deterministic simulation.
//
// Nothing about ball positions is ever sent over the wire. Each client gets the
// round's server-issued seed and rebuilds the identical arena from it, then
// walks a fixed 60Hz timestep. The only live input is the list of nudges, and
// each nudge carries the tick it applies on — so applying the same set of
// nudges to the same seed necessarily produces the same round everywhere.

import { ARENA, BALL_RADIUS, DT_MS, BALL_SPEED_MIN, BALL_SPEED_MAX, NUDGE_SPEED } from './config.js';
import { makeRng, seedToInt32, rand } from './rng.js';

const { Engine, Bodies, Body, Composite } = window.Matter;

// A unit vector drawn from the seeded stream. Built from a rejection sample
// rather than an angle so the only transcendental op involved is sqrt, which is
// exactly reproducible across JS engines (Math.sin/cos are not guaranteed to be).
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
      : {
          kind: 'block',
          w: rand.between(rng, 26, 150),
          h: rand.between(rng, 26, 150),
        };
    const halfW = isCircle ? cand.r : cand.w / 2;
    const halfH = isCircle ? cand.r : cand.h / 2;
    cand.x = rand.between(rng, inset + halfW, ARENA.w - inset - halfW);
    cand.y = rand.between(rng, inset + halfH, ARENA.h - inset - halfH);

    const clashes = bumpers.some((b) => {
      const bw = b.kind === 'circle' ? b.r : b.w / 2;
      const bh = b.kind === 'circle' ? b.r : b.h / 2;
      return (
        Math.abs(b.x - cand.x) < bw + halfW + 76 &&
        Math.abs(b.y - cand.y) < bh + halfH + 76
      );
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

    // Blend the inward aim with a random unit vector so launches are varied but
    // never point straight back into the wall they started from.
    const jitter = unitVector(rng);
    let vx = aim.x * 0.75 + jitter.x * 0.55;
    let vy = aim.y * 0.75 + jitter.y * 0.55;
    const m = Math.sqrt(vx * vx + vy * vy) || 1;
    const speed = rand.between(rng, 7.5, 9.5);
    balls.push({ x, y, vx: (vx / m) * speed, vy: (vy / m) * speed });
  }

  return { bumpers, balls };
}

export class Sim {
  /** @param round a drift_rounds row: seed, ball_count, duration_ms, blackout_ms */
  constructor(round) {
    this.round = round;
    this.layout = buildLayout(round.seed, round.ball_count);
    this.liveTicks = Math.round(round.duration_ms / DT_MS);
    this.freezeTick = Math.round((round.duration_ms + round.blackout_ms) / DT_MS);
    this.nudges = new Map(); // player_id -> nudge
    this.schedule = new Map(); // tick -> nudge[]
    this.build();
  }

  build() {
    if (this.engine) Engine.clear(this.engine);
    const engine = Engine.create();
    engine.gravity.x = 0;
    engine.gravity.y = 0;      // top-down arena
    engine.enableSleeping = false;
    this.engine = engine;

    const w = ARENA.wall;
    const walls = [
      Bodies.rectangle(ARENA.w / 2, w / 2, ARENA.w, w, { isStatic: true }),
      Bodies.rectangle(ARENA.w / 2, ARENA.h - w / 2, ARENA.w, w, { isStatic: true }),
      Bodies.rectangle(w / 2, ARENA.h / 2, w, ARENA.h, { isStatic: true }),
      Bodies.rectangle(ARENA.w - w / 2, ARENA.h / 2, w, ARENA.h, { isStatic: true }),
    ];
    for (const b of walls) { b.restitution = 1; b.friction = 0; b.frictionStatic = 0; }

    // Slightly super-elastic obstacles: every bumper hit adds a little energy,
    // which the per-tick speed clamp below then bounds. That is what keeps a
    // round chaotic instead of gradually settling down.
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

    Composite.add(engine.world, [...walls, ...this.bumperBodies, ...this.balls]);

    this.tick = 0;
    this.trails = this.balls.map(() => []);
    // Snapshot of the trails at the instant the balls go dark. Rendering this
    // instead of the live trail during the blackout is what stops the tail from
    // quietly giving away where the ball went.
    this.lastSeen = null;
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
    const existing = this.nudges.get(key);
    if (existing && existing.apply_tick === n.apply_tick && existing.ball_index === n.ball_index) {
      return false; // duplicate rebroadcast
    }
    if (existing) return false; // one nudge per player, first one wins
    this.nudges.set(key, { ...n, player_id: key });
    this.rebuildSchedule();
    if (n.apply_tick < this.tick) {
      const was = this.tick;
      this.build();
      this.advanceTo(was);
    }
    return true;
  }

  applyNudge(n) {
    const ball = this.balls[n.ball_index];
    if (!ball) return;
    const boost = NUDGE_SPEED * Math.max(0, Math.min(1, n.strength));
    Body.setVelocity(ball, {
      x: ball.velocity.x + n.dx * boost,
      y: ball.velocity.y + n.dy * boost,
    });
  }

  clampSpeeds() {
    for (const ball of this.balls) {
      const { x, y } = ball.velocity;
      const speed = Math.sqrt(x * x + y * y);
      if (speed < 1e-6) {
        Body.setVelocity(ball, { x: BALL_SPEED_MIN, y: 0 });
      } else if (speed < BALL_SPEED_MIN) {
        const k = BALL_SPEED_MIN / speed;
        Body.setVelocity(ball, { x: x * k, y: y * k });
      } else if (speed > BALL_SPEED_MAX) {
        const k = BALL_SPEED_MAX / speed;
        Body.setVelocity(ball, { x: x * k, y: y * k });
      }
    }
  }

  step() {
    const due = this.schedule.get(this.tick);
    if (due) for (const n of due) this.applyNudge(n);
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
    if (capped < this.tick) { this.build(); }
    // A whole round is ~500 ticks, so even a replay from zero is a few
    // milliseconds. The cap is pure paranoia against a pathological clock.
    let budget = 4000;
    while (this.tick < capped && budget-- > 0) this.step();
  }

  positions() {
    return this.balls.map((b) => ({ x: b.position.x, y: b.position.y }));
  }

  velocities() {
    return this.balls.map((b) => ({ x: b.velocity.x, y: b.velocity.y }));
  }
}
