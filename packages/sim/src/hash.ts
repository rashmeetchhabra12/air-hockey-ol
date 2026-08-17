import type { GameState } from './types.js';

/**
 * Deterministic state fingerprint, used for desync detection and for the
 * cross-runtime determinism tests.
 *
 * Hashes the *raw IEEE-754 bits* of every float rather than a decimal
 * rendering. A stringified value would silently mask a one-ULP divergence,
 * which is precisely the class of bug this is meant to catch.
 *
 * FNV-1a over the byte view: cheap enough to run every tick in debug builds.
 */

// Scratch buffers, reused across calls. The simulation is single-threaded per
// room, so this is safe and keeps hashing allocation-free on the hot path.
const SCRATCH_FLOATS = 32;
const buffer = new ArrayBuffer(SCRATCH_FLOATS * 8);
const floats = new Float64Array(buffer);
const bytes = new Uint8Array(buffer);

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * @returns an unsigned 32-bit fingerprint of the simulation-relevant state.
 *
 * Presentation-only fields (`lastGoalBy`, `lastGoalTick`) are excluded: they
 * cannot influence future state, so including them would make the hash reject
 * states that are in fact simulation-equivalent.
 */
export function hashState(state: GameState): number {
  let n = 0;

  floats[n++] = state.tick;
  floats[n++] = state.puck.x;
  floats[n++] = state.puck.y;
  floats[n++] = state.puck.vx;
  floats[n++] = state.puck.vy;

  // Fixed slot order is part of the determinism contract.
  for (let i = 0; i < state.paddles.length; i++) {
    const p = state.paddles[i]!;
    floats[n++] = p.x;
    floats[n++] = p.y;
    floats[n++] = p.vx;
    floats[n++] = p.vy;
    // Seeked target influences future ticks, so it belongs in the fingerprint.
    floats[n++] = p.targetX;
    floats[n++] = p.targetY;
  }

  for (let i = 0; i < state.score.length; i++) {
    floats[n++] = state.score[i]!;
  }

  floats[n++] = state.lastTouchedBy;
  floats[n++] = state.lastTouchTick;
  floats[n++] = state.freezeTicks;
  // Authority feeds back into itself through hysteresis, so it is simulation
  // state rather than a derived readout, and belongs in the fingerprint.
  floats[n++] = state.puckOwner;
  floats[n++] = state.puckOwnerEpoch;

  let hash = FNV_OFFSET_BASIS;
  const byteLength = n * 8;
  for (let i = 0; i < byteLength; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Hex rendering of {@link hashState}, for logs and test failure messages. */
export function hashStateHex(state: GameState): string {
  return hashState(state).toString(16).padStart(8, '0');
}
