import {
  DT,
  FACEOFF_FREEZE_TICKS,
  PADDLE_MAX_SPEED,
  PADDLE_RADIUS,
  PUCK_FRICTION,
  RINK_HEIGHT,
  RINK_WIDTH,
} from './config.js';
import { updatePuckAuthority } from './authority.js';
import { clamp, length } from './math.js';
import { advancePuck, containPuck, goalByPosition } from './physics.js';
import { cloneState, paddleBoundsX } from './state.js';
import type { GameState, InputSet, SimEvent } from './types.js';

const PADDLE_MIN_Y = PADDLE_RADIUS;
const PADDLE_MAX_Y = RINK_HEIGHT - PADDLE_RADIUS;
const PADDLE_MAX_STEP = PADDLE_MAX_SPEED * DT;

/** Where a paddle will be at the end of this tick. */
interface PaddleMove {
  x: number;
  y: number;
}

/**
 * Decide each paddle's motion for this tick without committing its position.
 *
 * Velocity is written immediately but position is *not*: the puck solver needs
 * to sweep against each paddle travelling from where it started this tick to
 * where it ends up. If the paddle were teleported to its final position first,
 * the swept contact test would be computed against a paddle that had already
 * arrived, and every strike would resolve a tick late and from the wrong place.
 *
 * The target is clamped into the player's own half *before* being stored, so a
 * malformed or hostile input is neutralised at the point of entry rather than
 * producing a partial effect after the fact. Realised velocity is derived from
 * the distance actually travelled, so an illegal request can never deliver a
 * legal-looking impulse.
 */
function planPaddles(state: GameState, inputs: InputSet): PaddleMove[] {
  const moves: PaddleMove[] = new Array<PaddleMove>(state.paddles.length);

  for (let slot = 0; slot < state.paddles.length; slot++) {
    const paddle = state.paddles[slot]!;
    const input = inputs[slot] ?? null;

    if (input !== null) {
      const bounds = paddleBoundsX(slot);
      paddle.targetX = clamp(input.targetX, bounds.minX, bounds.maxX);
      paddle.targetY = clamp(input.targetY, PADDLE_MIN_Y, PADDLE_MAX_Y);
    }

    const dx = paddle.targetX - paddle.x;
    const dy = paddle.targetY - paddle.y;
    const dist = length(dx, dy);

    let nextX: number;
    let nextY: number;
    if (dist <= PADDLE_MAX_STEP || dist === 0) {
      nextX = paddle.targetX;
      nextY = paddle.targetY;
    } else {
      const scale = PADDLE_MAX_STEP / dist;
      nextX = paddle.x + dx * scale;
      nextY = paddle.y + dy * scale;
    }

    paddle.vx = (nextX - paddle.x) / DT;
    paddle.vy = (nextY - paddle.y) / DT;
    moves[slot] = { x: nextX, y: nextY };
  }

  return moves;
}

/**
 * Commit the planned end-of-tick positions.
 *
 * Assigned directly from the plan rather than recomputed as `x + vx * DT`,
 * because that round-trip through the derived velocity is not bit-exact and
 * would leave the paddle a few ULPs away from where the solver assumed it landed.
 */
function commitPaddles(state: GameState, moves: PaddleMove[]): void {
  for (let slot = 0; slot < state.paddles.length; slot++) {
    const paddle = state.paddles[slot]!;
    const move = moves[slot]!;
    paddle.x = move.x;
    paddle.y = move.y;
  }
}

function resetPuckToCentre(state: GameState): void {
  state.puck.x = RINK_WIDTH / 2;
  state.puck.y = RINK_HEIGHT / 2;
  state.puck.vx = 0;
  state.puck.vy = 0;
  state.lastTouchedBy = -1;
  state.lastTouchTick = -1;
}

/**
 * Advance the simulation by exactly one tick.
 *
 * Pure: `state` is never mutated, and the result is a function of
 * `(state, inputs)` alone. No wall clock, no unseeded randomness, no I/O. That
 * purity is what makes rollback, replay, and headless testing all work against
 * the same code the server runs in production.
 *
 * Fixed order of operations, itself part of the contract:
 *   1. plan paddle motion (position held at tick start, velocity published)
 *   2. puck friction
 *   3. puck integrates continuously against the paddles as they sweep
 *   4. commit paddle positions
 *   5. goal consequences
 *
 * @param events optional sink for presentation-only events. Never read back, so
 *               passing `null` cannot change the simulation outcome.
 */
export function step(
  state: GameState,
  inputs: InputSet,
  events: SimEvent[] | null = null,
): GameState {
  const next = cloneState(state);
  next.tick = state.tick + 1;

  const moves = planPaddles(next, inputs);

  if (next.freezeTicks > 0) {
    // Post-goal pause. Players may reposition, but the puck is dead at centre.
    next.freezeTicks--;
    commitPaddles(next, moves);
    updatePuckAuthority(next);
    return next;
  }

  next.puck.vx *= PUCK_FRICTION;
  next.puck.vy *= PUCK_FRICTION;

  let scoringSlot = advancePuck(next, DT, events);

  // A crossing the puck was *pushed* through rather than travelled through is
  // invisible to the swept tests, so it is checked for separately.
  if (scoringSlot < 0) {
    scoringSlot = goalByPosition(next);
    if (scoringSlot >= 0) events?.push({ type: 'goal', scoringSlot, tick: next.tick });
  }

  // Last line of defence. Positional correction has no notion of walls, so a
  // pinned puck can be squeezed out of the rink entirely — and outside the
  // mouth that scores nothing, leaving the game running with no puck.
  if (scoringSlot < 0) containPuck(next);

  commitPaddles(next, moves);

  if (scoringSlot >= 0) {
    next.score[scoringSlot] = (next.score[scoringSlot] ?? 0) + 1;
    next.lastGoalBy = scoringSlot;
    next.lastGoalTick = next.tick;
    next.freezeTicks = FACEOFF_FREEZE_TICKS;
    resetPuckToCentre(next);
  }

  // Last, because ownership is decided from where the puck and paddles finally
  // ended up — including after a goal has reset them.
  updatePuckAuthority(next);

  return next;
}

/**
 * Run `count` ticks against a fixed input set.
 *
 * Used by tests, the bot's trajectory lookahead, and the headless harness.
 * Deliberately a plain loop over {@link step} — there is no separate fast path
 * that could drift away from the real one.
 */
export function stepMany(
  state: GameState,
  inputs: InputSet,
  count: number,
  events: SimEvent[] | null = null,
): GameState {
  let current = state;
  for (let i = 0; i < count; i++) {
    current = step(current, inputs, events);
  }
  return current;
}
