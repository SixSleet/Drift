// Deterministic PRNG. Everything the arena needs — bumper layout, ball spawns,
// launch angles — is drawn from here, so a single server-issued seed reproduces
// the identical round in every browser.

// mulberry32: small, fast, and uses only integer ops and a float divide, so it
// gives bit-identical results across JS engines.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Round seeds arrive as Postgres bigints (up to 2^53), which do not fit a
// 32-bit state. Fold both halves in so the whole seed contributes.
export function seedToInt32(seed) {
  const n = typeof seed === 'string' ? Number(seed) : seed;
  const lo = n >>> 0;
  const hi = Math.floor(n / 4294967296) >>> 0;
  return (lo ^ Math.imul(hi, 0x9e3779b1)) >>> 0;
}

export const rand = {
  between: (rng, lo, hi) => lo + rng() * (hi - lo),
  int: (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)),
  pick: (rng, arr) => arr[Math.floor(rng() * arr.length)],
  sign: (rng) => (rng() < 0.5 ? -1 : 1),
};
