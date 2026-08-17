/**
 * Determinism-safe scalar helpers.
 *
 * ## Why this file exists
 *
 * Client and server must produce bit-identical state from identical inputs. If
 * they diverge by even one ULP, that error compounds through the physics solver
 * and reconciliation never converges — which presents as unexplainable drift
 * that is extremely hard to trace back to its cause.
 *
 * IEEE-754 makes this tractable. ECMAScript requires `+ - * /` and `Math.sqrt`
 * to be *correctly rounded*, so they yield identical bits on every conformant
 * engine. What is **not** guaranteed is the transcendental family:
 * `Math.sin`, `cos`, `tan`, `pow`, `exp`, `log`, and `Math.hypot` are all
 * explicitly implementation-approximated, and V8, JavaScriptCore, and
 * SpiderMonkey genuinely disagree on their low bits.
 *
 * So the simulation is written to need none of them. Air hockey is pure vector
 * algebra — dot products, normalisation, and a quadratic — none of which
 * requires trigonometry. `Math.hypot` is the one trap worth naming explicitly:
 * it looks like exactly the right tool for computing a length, and it is not
 * correctly rounded. Use {@link length}, which is `sqrt(x*x + y*y)`.
 *
 * The ESLint config bans the unsafe calls inside `packages/sim` so this cannot
 * regress silently, and `test/determinism.test.ts` verifies the property holds.
 */

/** Correctly rounded, and therefore safe. Re-exported so the sim never touches `Math` directly. */
export const sqrt = Math.sqrt;
/** Exact: sign-bit manipulation only. */
export const abs = Math.abs;
/** Exact: comparison and selection only. */
export const min = Math.min;
/** Exact: comparison and selection only. */
export const max = Math.max;
/** Exact: comparison only. */
export const sign = Math.sign;
/** Exact: correctly rounded by definition. */
export const floor = Math.floor;

/** Constrain `v` to `[lo, hi]`. Comparison only, so exact. */
export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** Vector length. Deliberately not `Math.hypot`, which is not correctly rounded. */
export function length(x: number, y: number): number {
  return sqrt(x * x + y * y);
}

/** Squared length. Preferred wherever the comparison does not need the root. */
export function lengthSq(x: number, y: number): number {
  return x * x + y * y;
}

/**
 * Rescale `(x, y)` to at most `maxLen`, returning the scale factor to apply.
 * Returns 1 when already within bounds, so callers can skip the multiply.
 */
export function limitScale(x: number, y: number, maxLen: number): number {
  const lenSq = x * x + y * y;
  if (lenSq <= maxLen * maxLen) return 1;
  return maxLen / sqrt(lenSq);
}
