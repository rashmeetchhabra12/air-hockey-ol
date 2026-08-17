import { RINK_HEIGHT, RINK_WIDTH } from '@ah/sim';

/**
 * Fixed-point quantisation for the binary wire format.
 *
 * ## The tradeoff this represents
 *
 * A `float64` position costs 8 bytes and is exact. A 16-bit fixed-point one
 * costs 2 and is not. Sending exact values is what makes reconciliation
 * *bit-identical* — the property tested since P2 — because the client adopts the
 * server's numbers unchanged and replays from them.
 *
 * Quantising gives that up. The client now adopts a rounded version of the
 * server's state, so its replay starts from a slightly different world and can
 * reach a slightly different one. In a collision-driven simulation those
 * differences do not merely persist, they can amplify: a fraction of a unit is
 * occasionally the difference between a contact happening and not.
 *
 * The mitigating facts, which are why this is worth doing anyway:
 *
 *   - The step below is ~0.018 units, and the client's correction dead zone is
 *     0.05, so ordinary rounding is invisible.
 *   - Reconciliation re-syncs every 3 ticks, so divergence has almost no time to
 *     compound before being overwritten by fresh truth.
 *
 * Whether that holds in practice is a measurement, not an argument — the harness
 * reports correction error for both codecs so the cost can be read rather than
 * assumed.
 */

/**
 * Padding beyond the rink, in units.
 *
 * The puck legitimately leaves the playing surface: it crosses the goal line to
 * score, and contact resolution nudges it a hair past a wall. Encoding a
 * position that lands outside the representable range would wrap it to the far
 * side of the rink, so the range is deliberately larger than the geometry.
 */
const PAD = 64;

const POS_MIN = -PAD;
const POS_SPAN = Math.max(RINK_WIDTH, RINK_HEIGHT) + PAD * 2;

/**
 * Velocity range, in units per second.
 *
 * Comfortably above `PUCK_MAX_SPEED` and `PADDLE_MAX_SPEED`, since a paddle's
 * realised velocity is derived from distance travelled and can briefly exceed
 * its nominal cap at a clamp boundary.
 */
const VEL_LIMIT = 2048;

const U16_MAX = 65535;
const I16_MAX = 32767;

/** Position resolution in rink units. Exposed so tests can assert against it. */
export const POSITION_STEP = POS_SPAN / U16_MAX;

/** Velocity resolution in units per second. */
export const VELOCITY_STEP = (VEL_LIMIT * 2) / U16_MAX;

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Encode a position to 16 bits. Out-of-range values clamp rather than wrap. */
export function quantizePosition(v: number): number {
  const t = (v - POS_MIN) / POS_SPAN;
  return Math.round(clamp(t, 0, 1) * U16_MAX);
}

export function dequantizePosition(q: number): number {
  return (q / U16_MAX) * POS_SPAN + POS_MIN;
}

/** Encode a velocity to 16 signed bits. */
export function quantizeVelocity(v: number): number {
  const t = clamp(v, -VEL_LIMIT, VEL_LIMIT) / VEL_LIMIT;
  return Math.round(t * I16_MAX);
}

export function dequantizeVelocity(q: number): number {
  return (q / I16_MAX) * VEL_LIMIT;
}

/**
 * Round a target through the same grid the wire uses.
 *
 * Applied by the client *before* predicting, and regardless of which codec is
 * active. If the client predicted with a full-precision target and transmitted a
 * rounded one, the two sides would be simulating different intentions — a
 * divergence introduced by the encoding rather than by the network, and one that
 * would appear only when the binary codec was enabled. Quantising up front makes
 * codec choice a pure bandwidth decision.
 */
export function quantizeTarget(x: number, y: number): { x: number; y: number } {
  return {
    x: dequantizePosition(quantizePosition(x)),
    y: dequantizePosition(quantizePosition(y)),
  };
}
