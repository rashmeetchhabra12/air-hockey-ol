import { PLAYER_COUNT, RINK_HEIGHT, RINK_WIDTH } from '../src/config.js';
import { createInitialState } from '../src/state.js';
import type { GameState, InputSet, PlayerInput } from '../src/types.js';

/**
 * mulberry32 — a small, fast, fully specified PRNG.
 *
 * Tests need reproducible randomness: a fuzz failure is only useful if the exact
 * sequence can be replayed. `Math.random` is unseedable and would make failures
 * unreproducible, so it is never used here.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A state with the puck launched from centre at a chosen velocity. */
export function stateWithPuckVelocity(vx: number, vy: number): GameState {
  const state = createInitialState();
  state.puck.vx = vx;
  state.puck.vy = vy;
  return state;
}

/**
 * Generate a plausible input set: each player jitters its paddle around the
 * rink. Targets deliberately range over the *whole* rink, including the
 * opponent's half, so the clamping path is exercised on every tick.
 */
export function randomInputs(rng: () => number, seq: number): InputSet {
  const inputs: (PlayerInput | null)[] = [];
  for (let slot = 0; slot < PLAYER_COUNT; slot++) {
    inputs.push({
      seq,
      targetX: rng() * RINK_WIDTH,
      targetY: rng() * RINK_HEIGHT,
    });
  }
  return inputs;
}

/**
 * Build a full script of per-tick inputs up front.
 *
 * Materialising the script rather than generating inputs inside the run lets
 * the same sequence be replayed against a different starting state, which is
 * exactly what the rollback-equivalence test needs.
 */
export function buildInputScript(seed: number, ticks: number): InputSet[] {
  const rng = mulberry32(seed);
  const script: InputSet[] = new Array<InputSet>(ticks);
  for (let i = 0; i < ticks; i++) {
    // Hold the target for a few ticks at a time, so paddles travel in strokes
    // rather than vibrating in place — this produces far more real collisions.
    script[i] = i % 5 === 0 ? randomInputs(rng, i) : script[i - 1]!;
  }
  return script;
}
