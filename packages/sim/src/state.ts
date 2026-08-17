import {
  PADDLE_RADIUS,
  PLAYER_COUNT,
  RINK_HEIGHT,
  RINK_WIDTH,
  SLOT_LEFT,
} from './config.js';
import type { GameState, Paddle } from './types.js';

/** Face-off position for a slot, near that player's own goal. */
export function paddleHome(slot: number): { x: number; y: number } {
  // Close to their own goal, the way players actually line up for a face-off.
  return {
    x: slot === SLOT_LEFT ? RINK_WIDTH * 0.13 : RINK_WIDTH * 0.87,
    y: RINK_HEIGHT / 2,
  };
}

/**
 * Horizontal bounds for a slot's paddle centre.
 *
 * Each paddle is confined to its own half, inset by its radius. The two ranges
 * are disjoint by construction, which means paddles can never overlap each
 * other and the solver never has to consider paddle/paddle contact.
 */
export function paddleBoundsX(slot: number): { minX: number; maxX: number } {
  const half = RINK_WIDTH / 2;
  return slot === SLOT_LEFT
    ? { minX: PADDLE_RADIUS, maxX: half - PADDLE_RADIUS }
    : { minX: half + PADDLE_RADIUS, maxX: RINK_WIDTH - PADDLE_RADIUS };
}

function createPaddle(slot: number): Paddle {
  const home = paddleHome(slot);
  return {
    x: home.x,
    y: home.y,
    vx: 0,
    vy: 0,
    targetX: home.x,
    targetY: home.y,
  };
}

/** Move both paddles to their face-off positions. */
export function resetPaddlesHome(state: GameState): void {
  for (let slot = 0; slot < state.paddles.length; slot++) {
    const home = paddleHome(slot);
    const paddle = state.paddles[slot]!;
    paddle.x = home.x;
    paddle.y = home.y;
    paddle.targetX = home.x;
    paddle.targetY = home.y;
    paddle.vx = 0;
    paddle.vy = 0;
  }
}

/** Fresh match state: puck dead at centre, paddles at home, nil-nil. */
export function createInitialState(): GameState {
  const paddles: Paddle[] = [];
  for (let slot = 0; slot < PLAYER_COUNT; slot++) {
    paddles.push(createPaddle(slot));
  }

  return {
    tick: 0,
    paddles,
    puck: { x: RINK_WIDTH / 2, y: RINK_HEIGHT / 2, vx: 0, vy: 0 },
    score: new Array<number>(PLAYER_COUNT).fill(0),
    lastTouchedBy: -1,
    lastTouchTick: -1,
    freezeTicks: 0,
    winner: -1,
    puckOwner: -1,
    puckOwnerEpoch: 0,
    lastGoalBy: -1,
    lastGoalTick: -1,
  };
}

/**
 * Deep copy of a state.
 *
 * Written out field by field rather than via `structuredClone` or JSON: this is
 * on the hot path (every prediction replay clones once per unacked input) and
 * an explicit copy is both far faster and immune to a new field being silently
 * shared by reference.
 */
export function cloneState(s: GameState): GameState {
  const paddles: Paddle[] = new Array<Paddle>(s.paddles.length);
  for (let i = 0; i < s.paddles.length; i++) {
    const p = s.paddles[i]!;
    paddles[i] = {
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      targetX: p.targetX,
      targetY: p.targetY,
    };
  }

  return {
    tick: s.tick,
    paddles,
    puck: { x: s.puck.x, y: s.puck.y, vx: s.puck.vx, vy: s.puck.vy },
    score: s.score.slice(),
    lastTouchedBy: s.lastTouchedBy,
    lastTouchTick: s.lastTouchTick,
    freezeTicks: s.freezeTicks,
    winner: s.winner,
    puckOwner: s.puckOwner,
    puckOwnerEpoch: s.puckOwnerEpoch,
    lastGoalBy: s.lastGoalBy,
    lastGoalTick: s.lastGoalTick,
  };
}

/** Structural equality, for tests and desync diagnostics. */
export function statesEqual(a: GameState, b: GameState): boolean {
  if (
    a.tick !== b.tick ||
    a.puck.x !== b.puck.x ||
    a.puck.y !== b.puck.y ||
    a.puck.vx !== b.puck.vx ||
    a.puck.vy !== b.puck.vy ||
    a.lastTouchedBy !== b.lastTouchedBy ||
    a.lastTouchTick !== b.lastTouchTick ||
    a.freezeTicks !== b.freezeTicks ||
    a.winner !== b.winner ||
    a.puckOwner !== b.puckOwner ||
    a.puckOwnerEpoch !== b.puckOwnerEpoch ||
    a.paddles.length !== b.paddles.length ||
    a.score.length !== b.score.length
  ) {
    return false;
  }

  for (let i = 0; i < a.score.length; i++) {
    if (a.score[i] !== b.score[i]) return false;
  }

  for (let i = 0; i < a.paddles.length; i++) {
    const p = a.paddles[i]!;
    const q = b.paddles[i]!;
    if (
      p.x !== q.x ||
      p.y !== q.y ||
      p.vx !== q.vx ||
      p.vy !== q.vy ||
      p.targetX !== q.targetX ||
      p.targetY !== q.targetY
    ) {
      return false;
    }
  }

  return true;
}
