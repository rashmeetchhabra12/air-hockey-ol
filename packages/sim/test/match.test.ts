import { describe, expect, it } from 'vitest';

import {
  FACEOFF_FREEZE_TICKS,
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  MATCH_OVER_TICKS,
  PADDLE_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
  SLOT_LEFT,
  SLOT_RIGHT,
  WINNING_SCORE,
} from '../src/config.js';
import { cloneState, createInitialState, paddleBoundsX, paddleHome } from '../src/state.js';
import { step } from '../src/step.js';
import type { GameState, InputSet } from '../src/types.js';

const IDLE: InputSet = [null, null];

/**
 * Park both paddles in the bottom corners of their own halves.
 *
 * Face-off positions sit on the centre line, which is also the line from centre
 * ice into each goal mouth — a shot fired from there would be tested against a
 * paddle rather than against the scoring rule.
 */
function parkPaddles(state: GameState): void {
  for (const slot of [SLOT_LEFT, SLOT_RIGHT]) {
    const bounds = paddleBoundsX(slot);
    const paddle = state.paddles[slot]!;
    paddle.x = slot === SLOT_LEFT ? bounds.minX : bounds.maxX;
    paddle.y = RINK_HEIGHT - PADDLE_RADIUS;
    paddle.targetX = paddle.x;
    paddle.targetY = paddle.y;
    paddle.vx = 0;
    paddle.vy = 0;
  }
}

/** Fire the puck into the right goal, so `SLOT_LEFT` scores. */
function shootAtRightGoal(state: GameState): void {
  state.puck.x = RINK_WIDTH * 0.7;
  state.puck.y = (GOAL_Y_MIN + GOAL_Y_MAX) / 2;
  state.puck.vx = 1400;
  state.puck.vy = 0;
}

function stepUntil(
  state: GameState,
  predicate: (s: GameState) => boolean,
  maxTicks: number,
  description: string,
): GameState {
  let current = state;
  for (let i = 0; i < maxTicks; i++) {
    if (predicate(current)) return current;
    current = step(current, IDLE);
  }
  throw new Error(`never reached: ${description}`);
}

/** Score one goal for the left player from a live, unfrozen state. */
function scoreOnce(state: GameState): GameState {
  const before = state.score[SLOT_LEFT] ?? 0;
  const shot = cloneState(state);
  parkPaddles(shot);
  shootAtRightGoal(shot);
  return stepUntil(shot, (s) => (s.score[SLOT_LEFT] ?? 0) > before, 120, 'a goal');
}

describe('match rules', () => {
  it('does not declare a winner before the winning score', () => {
    const state = createInitialState();
    state.score[SLOT_LEFT] = WINNING_SCORE - 2;

    const scored = scoreOnce(state);

    expect(scored.score[SLOT_LEFT]).toBe(WINNING_SCORE - 1);
    expect(scored.winner).toBe(-1);
    expect(scored.freezeTicks).toBe(FACEOFF_FREEZE_TICKS);
  });

  it('declares the player who reaches the winning score the winner', () => {
    const state = createInitialState();
    state.score[SLOT_LEFT] = WINNING_SCORE - 1;

    const scored = scoreOnce(state);

    expect(scored.score[SLOT_LEFT]).toBe(WINNING_SCORE);
    expect(scored.winner).toBe(SLOT_LEFT);
    // The result is held on screen longer than an ordinary face-off pause, so
    // there is time to read it before the next match starts.
    expect(scored.freezeTicks).toBe(MATCH_OVER_TICKS);
  });

  it('starts a fresh match once the result has been shown', () => {
    const state = createInitialState();
    state.score[SLOT_LEFT] = WINNING_SCORE - 1;

    const won = scoreOnce(state);
    // One tick past the end of the result freeze.
    const fresh = stepUntil(won, (s) => s.winner < 0, MATCH_OVER_TICKS + 5, 'a fresh match');

    expect(fresh.winner).toBe(-1);
    expect(fresh.score[SLOT_LEFT]).toBe(0);
    expect(fresh.score[SLOT_RIGHT]).toBe(0);
    expect(fresh.freezeTicks).toBe(FACEOFF_FREEZE_TICKS);
    expect(fresh.puck.x).toBe(RINK_WIDTH / 2);
    expect(fresh.puck.y).toBe(RINK_HEIGHT / 2);
  });

  it('lines both paddles up at their own end when a fresh match begins', () => {
    const state = createInitialState();
    state.score[SLOT_LEFT] = WINNING_SCORE - 1;

    const won = scoreOnce(state);
    const fresh = stepUntil(won, (s) => s.winner < 0, MATCH_OVER_TICKS + 5, 'a fresh match');

    for (const slot of [SLOT_LEFT, SLOT_RIGHT]) {
      const home = paddleHome(slot);
      const paddle = fresh.paddles[slot]!;
      expect(paddle.x).toBe(home.x);
      expect(paddle.y).toBe(home.y);
      expect(paddle.vx).toBe(0);
      expect(paddle.vy).toBe(0);
    }
  });

  /**
   * Guards the reasoning in `step`: a face-off reset driven by goal detection
   * would make the local paddle depend on the opponent's, which the client
   * cannot predict.
   */
  it('leaves the paddles alone on an ordinary goal', () => {
    const state = createInitialState();
    const shot = cloneState(state);
    parkPaddles(shot);
    shootAtRightGoal(shot);

    const before = shot.paddles.map((p) => ({ x: p.x, y: p.y }));
    const scored = stepUntil(shot, (s) => (s.score[SLOT_LEFT] ?? 0) > 0, 120, 'a goal');

    for (let slot = 0; slot < scored.paddles.length; slot++) {
      expect(scored.paddles[slot]!.x).toBe(before[slot]!.x);
      expect(scored.paddles[slot]!.y).toBe(before[slot]!.y);
    }
  });

  it('starts each player near their own goal rather than at centre', () => {
    const state = createInitialState();

    expect(state.paddles[SLOT_LEFT]!.x).toBeLessThan(RINK_WIDTH * 0.25);
    expect(state.paddles[SLOT_RIGHT]!.x).toBeGreaterThan(RINK_WIDTH * 0.75);
  });
});
