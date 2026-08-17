import {
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  MAX_CCD_ITERATIONS,
  PADDLE_RADIUS,
  PADDLE_RESTITUTION,
  POST_RADIUS,
  PUCK_MAX_SPEED,
  PUCK_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
  SEPARATION_EPSILON,
  SLOT_LEFT,
  SLOT_RIGHT,
  TIME_EPSILON,
  WALL_RESTITUTION,
} from './config.js';
import { limitScale, sqrt } from './math.js';
import type { GameState, Puck, SimEvent } from './types.js';

// Bounds on the puck *centre*. The playing surface itself spans [0, RINK_*].
const MIN_X = PUCK_RADIUS;
const MAX_X = RINK_WIDTH - PUCK_RADIUS;
const MIN_Y = PUCK_RADIUS;
const MAX_Y = RINK_HEIGHT - PUCK_RADIUS;

/** Goal lines sit on the end-wall surfaces; crossing one with the centre scores. */
const GOAL_LINE_LEFT = 0;
const GOAL_LINE_RIGHT = RINK_WIDTH;

const PUCK_PADDLE_SUM = PUCK_RADIUS + PADDLE_RADIUS;
const PUCK_POST_SUM = PUCK_RADIUS + POST_RADIUS;

/**
 * Goal posts, as solid circles at the four mouth edges.
 *
 * Modelling these explicitly is what lets a shot ricochet off the post instead
 * of passing through a mathematically sharp corner, and it removes the
 * ambiguity at the exact boundary between "hits the end wall" and "enters the
 * mouth". Order is fixed and iterated by index — part of the determinism contract.
 */
const POSTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: GOAL_LINE_LEFT, y: GOAL_Y_MIN },
  { x: GOAL_LINE_LEFT, y: GOAL_Y_MAX },
  { x: GOAL_LINE_RIGHT, y: GOAL_Y_MIN },
  { x: GOAL_LINE_RIGHT, y: GOAL_Y_MAX },
];

// Collision kinds. Plain constants rather than a `const enum`, which
// `isolatedModules` disallows.
const HIT_NONE = 0;
const HIT_WALL = 1;
const HIT_POST = 2;
const HIT_PADDLE = 3;
const HIT_GOAL = 4;

/**
 * Earliest time in `[0, dt]` at which two circles under constant velocity come
 * into contact, or `-1` if they do not.
 *
 * Solves `|d + t·v|² = R²` for the smaller root. Uses only `+ - * /` and
 * `sqrt`, all of which IEEE-754 requires to be correctly rounded, so the result
 * is bit-identical across engines.
 *
 * Returns `0` when the circles already overlap, letting the caller resolve the
 * penetration immediately rather than sweeping through it.
 */
export function sweepCircleVsCircle(
  ax: number,
  ay: number,
  avx: number,
  avy: number,
  bx: number,
  by: number,
  bvx: number,
  bvy: number,
  radiusSum: number,
  dt: number,
): number {
  const dx = ax - bx;
  const dy = ay - by;

  const c = dx * dx + dy * dy - radiusSum * radiusSum;
  if (c <= 0) return 0; // already interpenetrating

  const vx = avx - bvx;
  const vy = avy - bvy;

  const b = dx * vx + dy * vy;
  if (b >= 0) return -1; // separating or parallel

  const a = vx * vx + vy * vy;
  if (a <= 0) return -1; // no relative motion

  const disc = b * b - a * c;
  if (disc < 0) return -1; // passes by without touching

  const t = (-b - sqrt(disc)) / a;
  if (t < 0 || t > dt) return -1;
  return t;
}

/** Reflect the puck off a static surface. Returns the approach speed, or 0 if separating. */
function reflectStatic(puck: Puck, nx: number, ny: number, restitution: number): number {
  const vn = puck.vx * nx + puck.vy * ny;
  if (vn >= 0) return 0;

  const j = -(1 + restitution) * vn;
  puck.vx += j * nx;
  puck.vy += j * ny;

  // Nudge clear of the surface so the next sweep does not immediately re-detect
  // the same contact at t = 0 and stall the iteration budget.
  puck.x += nx * SEPARATION_EPSILON;
  puck.y += ny * SEPARATION_EPSILON;

  return -vn;
}

/**
 * Apply a paddle strike.
 *
 * Solved in the paddle's reference frame with the paddle treated as infinite
 * mass, so the paddle's own motion is inherited by the puck: a puck struck by a
 * paddle moving at speed S departs at up to `(1 + e)·S`. This is what makes a
 * driven shot feel distinct from a puck rebounding off a stationary paddle, and
 * it needs no separate transfer coefficient.
 */
function resolvePaddleHit(
  puck: Puck,
  pvx: number,
  pvy: number,
  nx: number,
  ny: number,
): number {
  const rvx = puck.vx - pvx;
  const rvy = puck.vy - pvy;
  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return 0;

  const j = -(1 + PADDLE_RESTITUTION) * vn;
  puck.vx += j * nx;
  puck.vy += j * ny;

  puck.x += nx * SEPARATION_EPSILON;
  puck.y += ny * SEPARATION_EPSILON;

  return -vn;
}

function clampPuckSpeed(puck: Puck): void {
  const scale = limitScale(puck.vx, puck.vy, PUCK_MAX_SPEED);
  if (scale !== 1) {
    puck.vx *= scale;
    puck.vy *= scale;
  }
}

/**
 * Push the puck out of any paddle it is already inside at the start of the tick.
 *
 * Paddles are integrated before the puck, so a fast paddle can legitimately end
 * its move overlapping the puck. Without this pass the sweep would see `c <= 0`,
 * return t = 0 forever, and burn the whole iteration budget without progress.
 */
function resolveInitialOverlap(state: GameState, events: SimEvent[] | null): void {
  const puck = state.puck;

  for (let slot = 0; slot < state.paddles.length; slot++) {
    const paddle = state.paddles[slot]!;
    let dx = puck.x - paddle.x;
    let dy = puck.y - paddle.y;
    const distSq = dx * dx + dy * dy;
    if (distSq >= PUCK_PADDLE_SUM * PUCK_PADDLE_SUM) continue;

    let dist = sqrt(distSq);
    if (dist === 0) {
      // Exactly concentric. Any normal is geometrically valid; pick a fixed one
      // so every runtime makes the same choice.
      dx = 1;
      dy = 0;
      dist = 1;
    }

    const nx = dx / dist;
    const ny = dy / dist;

    // Positional correction first, then the impulse.
    const penetration = PUCK_PADDLE_SUM - dist + SEPARATION_EPSILON;
    puck.x += nx * penetration;
    puck.y += ny * penetration;

    const speed = resolvePaddleHit(puck, paddle.vx, paddle.vy, nx, ny);
    if (speed > 0) {
      clampPuckSpeed(puck);
      state.lastTouchedBy = slot;
      state.lastTouchTick = state.tick;
      events?.push({ type: 'paddleHit', slot, tick: state.tick, speed });
    }
  }
}

/**
 * Has the puck ended up past a goal line, inside the mouth?
 *
 * The swept tests can only detect a crossing the puck *travels* through, and
 * not every crossing is travelled. Resolving an overlap displaces the puck
 * along the contact normal without any velocity being involved, so a paddle
 * pressing a nearly stationary puck into the mouth can shove it through the
 * goal line while `vx` is still zero — at which point the sweep never runs, no
 * goal is scored, and the puck comes to rest outside the rink with play
 * quietly stalled.
 *
 * Found by a bot match that produced a puck at x = -18 and a score of nil-nil.
 */
export function goalByPosition(state: GameState): number {
  const y = state.puck.y;
  if (y <= GOAL_Y_MIN || y >= GOAL_Y_MAX) return -1;
  if (state.puck.x <= GOAL_LINE_LEFT) return SLOT_RIGHT;
  if (state.puck.x >= GOAL_LINE_RIGHT) return SLOT_LEFT;
  return -1;
}

/**
 * Force the puck back inside the rink if anything pushed it out.
 *
 * The swept solver cannot let the puck cross a wall, but positional correction
 * can. Resolving an overlap displaces the puck along the contact normal by
 * whatever depth is needed, with no notion of walls — so a paddle pinning the
 * puck against an end wall squeezes it straight through. Outside the goal mouth
 * nothing scores, so it simply stays there: gone from the rink, rendered off
 * canvas, and never coming back. Play continues with an invisible puck.
 *
 * A last-resort clamp rather than a rule of the game. It should never fire in
 * ordinary play, and the containment tests assert as much — but "should never"
 * is not a guarantee, and the failure mode is the game silently ending.
 *
 * The goal mouth is deliberately exempt on the x axis: a puck crossing the line
 * to score is legitimately outside the surface, and clamping it back would make
 * scoring impossible.
 */
export function containPuck(state: GameState): void {
  const puck = state.puck;

  if (puck.y < MIN_Y) puck.y = MIN_Y;
  else if (puck.y > MAX_Y) puck.y = MAX_Y;

  const inMouth = puck.y > GOAL_Y_MIN && puck.y < GOAL_Y_MAX;
  if (inMouth) return;

  if (puck.x < MIN_X) puck.x = MIN_X;
  else if (puck.x > MAX_X) puck.x = MAX_X;
}

/**
 * Advance the puck through `dt` seconds, resolving collisions in strict
 * time-of-impact order.
 *
 * Continuous rather than discrete: at `PUCK_MAX_SPEED` the puck covers 30 units
 * per tick, well over its own radius, so naive `position += velocity * dt`
 * stepping would let it pass straight through paddles and walls. Each iteration
 * finds the single earliest contact across every obstacle, advances exactly that
 * far, resolves it, and repeats with the remaining time.
 *
 * @returns the slot credited with a goal, or -1. The caller applies the
 *          scoring consequences; this function only moves the puck.
 */
export function advancePuck(
  state: GameState,
  dt: number,
  events: SimEvent[] | null,
): number {
  const puck = state.puck;

  resolveInitialOverlap(state, events);

  let remaining = dt;
  let iterations = 0;

  while (remaining > TIME_EPSILON) {
    if (iterations >= MAX_CCD_ITERATIONS) {
      // Pathological pile-up (a puck pinched between a paddle and a wall).
      // Abandoning the leftover motion is deterministic and safe; letting it
      // through un-swept would risk tunnelling out of the rink.
      break;
    }
    iterations++;

    let bestT = remaining;
    let bestKind = HIT_NONE;
    let bestNx = 0;
    let bestNy = 0;
    let bestSlot = -1;

    // --- End walls and goal mouths -------------------------------------------
    // The wall face and the goal line are different planes at the same end. The
    // wall is solid only outside the mouth; the goal line only counts inside it.
    if (puck.vx < 0) {
      const tWall = (MIN_X - puck.x) / puck.vx;
      if (tWall >= 0 && tWall < bestT) {
        const yAt = puck.y + puck.vy * tWall;
        if (yAt <= GOAL_Y_MIN || yAt >= GOAL_Y_MAX) {
          bestT = tWall;
          bestKind = HIT_WALL;
          bestNx = 1;
          bestNy = 0;
        }
      }
      const tGoal = (GOAL_LINE_LEFT - puck.x) / puck.vx;
      if (tGoal >= 0 && tGoal < bestT) {
        const yAt = puck.y + puck.vy * tGoal;
        if (yAt > GOAL_Y_MIN && yAt < GOAL_Y_MAX) {
          bestT = tGoal;
          bestKind = HIT_GOAL;
          bestSlot = SLOT_RIGHT; // scored on the left goal, so the right player scores
        }
      }
    } else if (puck.vx > 0) {
      const tWall = (MAX_X - puck.x) / puck.vx;
      if (tWall >= 0 && tWall < bestT) {
        const yAt = puck.y + puck.vy * tWall;
        if (yAt <= GOAL_Y_MIN || yAt >= GOAL_Y_MAX) {
          bestT = tWall;
          bestKind = HIT_WALL;
          bestNx = -1;
          bestNy = 0;
        }
      }
      const tGoal = (GOAL_LINE_RIGHT - puck.x) / puck.vx;
      if (tGoal >= 0 && tGoal < bestT) {
        const yAt = puck.y + puck.vy * tGoal;
        if (yAt > GOAL_Y_MIN && yAt < GOAL_Y_MAX) {
          bestT = tGoal;
          bestKind = HIT_GOAL;
          bestSlot = SLOT_LEFT;
        }
      }
    }

    // --- Side walls (solid for their full length) ----------------------------
    if (puck.vy < 0) {
      const t = (MIN_Y - puck.y) / puck.vy;
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestKind = HIT_WALL;
        bestNx = 0;
        bestNy = 1;
      }
    } else if (puck.vy > 0) {
      const t = (MAX_Y - puck.y) / puck.vy;
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestKind = HIT_WALL;
        bestNx = 0;
        bestNy = -1;
      }
    }

    // --- Goal posts ----------------------------------------------------------
    for (let i = 0; i < POSTS.length; i++) {
      const post = POSTS[i]!;
      const t = sweepCircleVsCircle(
        puck.x, puck.y, puck.vx, puck.vy,
        post.x, post.y, 0, 0,
        PUCK_POST_SUM, bestT,
      );
      if (t >= 0 && t < bestT) {
        const cx = puck.x + puck.vx * t - post.x;
        const cy = puck.y + puck.vy * t - post.y;
        const len = sqrt(cx * cx + cy * cy);
        if (len > 0) {
          bestT = t;
          bestKind = HIT_POST;
          bestNx = cx / len;
          bestNy = cy / len;
        }
      }
    }

    // --- Paddles (iterated by slot index, never by arrival order) ------------
    for (let slot = 0; slot < state.paddles.length; slot++) {
      const paddle = state.paddles[slot]!;
      const t = sweepCircleVsCircle(
        puck.x, puck.y, puck.vx, puck.vy,
        paddle.x, paddle.y, paddle.vx, paddle.vy,
        PUCK_PADDLE_SUM, bestT,
      );
      if (t >= 0 && t < bestT) {
        const cx = puck.x + puck.vx * t - (paddle.x + paddle.vx * t);
        const cy = puck.y + puck.vy * t - (paddle.y + paddle.vy * t);
        const len = sqrt(cx * cx + cy * cy);
        if (len > 0) {
          bestT = t;
          bestKind = HIT_PADDLE;
          bestNx = cx / len;
          bestNy = cy / len;
          bestSlot = slot;
        }
      }
    }

    // --- Integrate to the earliest contact -----------------------------------
    if (bestKind === HIT_NONE) {
      puck.x += puck.vx * remaining;
      puck.y += puck.vy * remaining;
      break;
    }

    puck.x += puck.vx * bestT;
    puck.y += puck.vy * bestT;
    remaining -= bestT;

    if (bestKind === HIT_GOAL) {
      events?.push({ type: 'goal', scoringSlot: bestSlot, tick: state.tick });
      return bestSlot;
    }

    if (bestKind === HIT_PADDLE) {
      const paddle = state.paddles[bestSlot]!;
      const speed = resolvePaddleHit(puck, paddle.vx, paddle.vy, bestNx, bestNy);
      if (speed > 0) {
        state.lastTouchedBy = bestSlot;
        state.lastTouchTick = state.tick;
        events?.push({ type: 'paddleHit', slot: bestSlot, tick: state.tick, speed });
      }
    } else if (bestKind === HIT_POST) {
      const speed = reflectStatic(puck, bestNx, bestNy, WALL_RESTITUTION);
      if (speed > 0) events?.push({ type: 'postHit', tick: state.tick, speed });
    } else {
      const speed = reflectStatic(puck, bestNx, bestNy, WALL_RESTITUTION);
      if (speed > 0) events?.push({ type: 'wallHit', tick: state.tick, speed });
    }

    clampPuckSpeed(puck);
  }

  return -1;
}
