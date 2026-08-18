import { describe, expect, it } from 'vitest';

import {
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  PADDLE_RADIUS,
  PUCK_FRICTION,
  PUCK_MAX_SPEED,
  PUCK_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
  SLOT_LEFT,
  SLOT_RIGHT,
  TICK_RATE,
  WALL_RESTITUTION,
} from '../src/config.js';
import { length } from '../src/math.js';
import { sweepCircleVsCircle } from '../src/physics.js';
import { createInitialState, paddleBoundsX } from '../src/state.js';
import { step, stepMany } from '../src/step.js';
import type { GameState, InputSet, SimEvent } from '../src/types.js';
import { buildInputScript, stateWithPuckVelocity } from './helpers.js';

/** No input this tick for either player: paddles hold their existing target. */
const IDLE: InputSet = [null, null];

function puckSpeed(state: GameState): number {
  return length(state.puck.vx, state.puck.vy);
}

/**
 * Park both paddles in the far corners of their own halves.
 *
 * The default home positions sit on the rink's centre line, which is also the
 * line from centre ice to the middle of each goal mouth — so any test that
 * fires a shot straight at a goal would actually be testing a paddle save.
 * Tests about walls, posts, and scoring need the paddles demonstrably out of
 * the way.
 */
function parkPaddles(state: GameState): void {
  for (const slot of [SLOT_LEFT, SLOT_RIGHT]) {
    const bounds = paddleBoundsX(slot);
    const paddle = state.paddles[slot]!;
    paddle.x = slot === SLOT_LEFT ? bounds.minX : bounds.maxX;
    // Bottom corner: every shot line used in these tests runs through the upper
    // half or the centre, leaving hundreds of units of clearance rather than a
    // margin that a tuning change could silently erase.
    paddle.y = RINK_HEIGHT - PADDLE_RADIUS;
    paddle.targetX = paddle.x;
    paddle.targetY = paddle.y;
    paddle.vx = 0;
    paddle.vy = 0;
  }
}

/**
 * Step until `predicate` holds, failing loudly if it never does.
 *
 * An unbounded `while` in a test turns a regression into a hung run with no
 * output, which is far harder to diagnose than an assertion failure.
 */
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
  if (!predicate(current)) {
    throw new Error(`${description} did not occur within ${maxTicks} ticks`);
  }
  return current;
}

/**
 * How far outside the playing surface the puck centre is allowed to stray.
 *
 * Not zero: resolving a contact nudges the puck along the contact normal by
 * `SEPARATION_EPSILON` to stop it re-detecting the same collision at t = 0, and
 * a paddle pinning the puck against a wall pushes it a little further. The
 * bound is deliberately tight enough that genuine tunnelling — which throws the
 * puck hundreds of units clear — still fails the check.
 */
const ESCAPE_TOLERANCE = 20;

function assertPuckContained(state: GameState, context: string): void {
  expect(state.puck.x, `${context}: puck escaped left`).toBeGreaterThan(-ESCAPE_TOLERANCE);
  expect(state.puck.x, `${context}: puck escaped right`).toBeLessThan(RINK_WIDTH + ESCAPE_TOLERANCE);
  expect(state.puck.y, `${context}: puck escaped top`).toBeGreaterThan(-ESCAPE_TOLERANCE);
  expect(state.puck.y, `${context}: puck escaped bottom`).toBeLessThan(
    RINK_HEIGHT + ESCAPE_TOLERANCE,
  );
}

describe('containment invariants', () => {
  /**
   * The single most valuable physics test in the project.
   *
   * A puck at `PUCK_MAX_SPEED` travels 30 units per tick, comfortably more than
   * its own diameter, so discrete `position += velocity * dt` integration would
   * let it pass straight through paddles and walls. This exercises the
   * continuous solver against thrashing paddles for a long run and asserts the
   * puck never leaves the rink.
   */
  it('keeps the puck inside the rink across a long adversarial run', () => {
    const TICKS = 20_000;
    const script = buildInputScript(0xd15ea5e, TICKS);

    let state = stateWithPuckVelocity(PUCK_MAX_SPEED * 0.7, -PUCK_MAX_SPEED * 0.6);

    for (let i = 0; i < TICKS; i++) {
      state = step(state, script[i]!);
      assertPuckContained(state, `tick ${i}`);
    }
  });

  it('never exceeds the puck speed ceiling, even under repeated paddle strikes', () => {
    const TICKS = 20_000;
    const script = buildInputScript(0xfeed, TICKS);

    let state = stateWithPuckVelocity(400, 300);
    let observedMax = 0;

    for (let i = 0; i < TICKS; i++) {
      state = step(state, script[i]!);
      observedMax = Math.max(observedMax, puckSpeed(state));
    }

    // A small tolerance: the cap is applied after each impulse within a tick,
    // and friction is applied before the sweep.
    expect(observedMax).toBeLessThanOrEqual(PUCK_MAX_SPEED * 1.001);
    // Sanity check that the run actually produced hard strikes rather than
    // trivially passing because nothing ever happened.
    expect(observedMax).toBeGreaterThan(PUCK_MAX_SPEED * 0.5);
  });

  it('confines each paddle to its own half regardless of requested target', () => {
    const TICKS = 3000;
    const script = buildInputScript(0xa11ce, TICKS);

    let state = createInitialState();
    for (let i = 0; i < TICKS; i++) {
      state = step(state, script[i]!);

      for (const slot of [SLOT_LEFT, SLOT_RIGHT]) {
        const bounds = paddleBoundsX(slot);
        const paddle = state.paddles[slot]!;
        expect(paddle.x).toBeGreaterThanOrEqual(bounds.minX);
        expect(paddle.x).toBeLessThanOrEqual(bounds.maxX);
        expect(paddle.y).toBeGreaterThanOrEqual(PADDLE_RADIUS);
        expect(paddle.y).toBeLessThanOrEqual(RINK_HEIGHT - PADDLE_RADIUS);
      }
    }
  });

  it('never lets the two paddles overlap', () => {
    const TICKS = 3000;
    const script = buildInputScript(0xb0b, TICKS);

    let state = createInitialState();
    for (let i = 0; i < TICKS; i++) {
      state = step(state, script[i]!);
      const a = state.paddles[SLOT_LEFT]!;
      const b = state.paddles[SLOT_RIGHT]!;
      // Disjoint half-ranges make this structurally impossible; the test pins
      // that guarantee down so a future bounds change cannot quietly break it.
      expect(length(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(PADDLE_RADIUS * 2);
    }
  });
});

describe('wall and post behaviour', () => {
  it('reflects a perpendicular wall strike with the configured restitution', () => {
    // Aim at the top wall, well away from either goal mouth.
    let state = createInitialState();
    state.puck.x = RINK_WIDTH / 2;
    state.puck.y = RINK_HEIGHT / 2;
    state.puck.vx = 0;
    state.puck.vy = -600;

    const before = Math.abs(state.puck.vy);
    state = stepMany(state, IDLE, 40);

    expect(state.puck.vy).toBeGreaterThan(0); // now travelling back down
    // Friction acts over the whole run, so the expected value is the restitution
    // *and* forty ticks of decay. Accounting for it explicitly rather than with
    // a loose band keeps this a test of the bounce rather than of the tolerance.
    const decayed = before * WALL_RESTITUTION * PUCK_FRICTION ** 40;
    expect(Math.abs(state.puck.vy)).toBeLessThan(before * WALL_RESTITUTION * 1.01);
    expect(Math.abs(state.puck.vy)).toBeGreaterThan(decayed * 0.95);
  });

  it('bounces off an end wall above the goal mouth instead of scoring', () => {
    let state = createInitialState();
    parkPaddles(state);
    state.puck.x = RINK_WIDTH / 2;
    state.puck.y = GOAL_Y_MIN / 2; // clearly outside the mouth
    state.puck.vx = -900;
    state.puck.vy = 0;

    state = stepMany(state, IDLE, 60);

    expect(state.score[SLOT_LEFT]).toBe(0);
    expect(state.score[SLOT_RIGHT]).toBe(0);
    expect(state.puck.vx).toBeGreaterThan(0); // rebounded
  });

  it('deflects a shot that clips the goal post', () => {
    let state = createInitialState();
    parkPaddles(state);
    // Offset above the post centre so this is a glancing blow. Aimed dead at the
    // post's centre the puck would rebound straight back along its own line with
    // no vertical component, which is correct but tests nothing about deflection.
    state.puck.x = RINK_WIDTH / 2;
    state.puck.y = GOAL_Y_MIN - 12;
    state.puck.vx = -1000;
    state.puck.vy = 0;

    const events: SimEvent[] = [];
    for (let i = 0; i < 60; i++) {
      state = step(state, IDLE, events);
    }

    expect(events.some((e) => e.type === 'postHit')).toBe(true);
    // The post must impart vertical motion the shot did not start with.
    expect(Math.abs(state.puck.vy)).toBeGreaterThan(0);
    expect(state.score[SLOT_RIGHT]).toBe(0);
  });
});

describe('scoring', () => {
  it('credits the right player when the puck enters the left goal', () => {
    let state = createInitialState();
    parkPaddles(state);
    state.puck.x = RINK_WIDTH / 2;
    state.puck.y = (GOAL_Y_MIN + GOAL_Y_MAX) / 2;
    state.puck.vx = -1200;
    state.puck.vy = 0;

    const events: SimEvent[] = [];
    for (let i = 0; i < 60; i++) {
      state = step(state, IDLE, events);
    }

    expect(state.score[SLOT_RIGHT]).toBe(1);
    expect(state.score[SLOT_LEFT]).toBe(0);
    expect(events.some((e) => e.type === 'goal' && e.scoringSlot === SLOT_RIGHT)).toBe(true);
  });

  it('credits the left player when the puck enters the right goal', () => {
    let state = createInitialState();
    parkPaddles(state);
    state.puck.x = RINK_WIDTH / 2;
    state.puck.y = (GOAL_Y_MIN + GOAL_Y_MAX) / 2;
    state.puck.vx = 1200;
    state.puck.vy = 0;

    state = stepMany(state, IDLE, 60);

    expect(state.score[SLOT_LEFT]).toBe(1);
    expect(state.score[SLOT_RIGHT]).toBe(0);
  });

  it('resets the puck to centre and freezes play after a goal', () => {
    let state = createInitialState();
    parkPaddles(state);
    state.puck.x = RINK_WIDTH / 2;
    state.puck.y = (GOAL_Y_MIN + GOAL_Y_MAX) / 2;
    state.puck.vx = -1200;

    state = stepUntil(state, (s) => s.score[SLOT_RIGHT] === 1, 120, 'left goal');

    expect(state.puck.x).toBe(RINK_WIDTH / 2);
    expect(state.puck.y).toBe(RINK_HEIGHT / 2);
    expect(puckSpeed(state)).toBe(0);
    expect(state.freezeTicks).toBeGreaterThan(0);

    // The puck stays dead for the whole freeze.
    const frozen = state.freezeTicks;
    state = stepMany(state, IDLE, frozen);
    expect(puckSpeed(state)).toBe(0);
    expect(state.freezeTicks).toBe(0);
  });
});

describe('goals the puck was pushed through', () => {
  /**
   * Not every crossing of the goal line is one the puck *travels* through.
   *
   * Resolving an overlap displaces the puck along the contact normal with no
   * velocity involved, so a paddle pressing a nearly stationary puck into the
   * mouth can shove it past the line while `vx` is still zero. The swept tests
   * only fire on motion, so nothing scored: the puck came to rest outside the
   * rink and play stalled with the score untouched.
   *
   * Found by a bot-versus-bot match that ended with the puck at x = -18 and a
   * score of nil-nil.
   */
  it('scores a puck shoved over the line by an overlapping paddle', () => {
    const state = createInitialState();
    parkPaddles(state);

    // Dead puck sitting just inside the left goal mouth.
    state.puck.x = 6;
    state.puck.y = RINK_HEIGHT / 2;
    state.puck.vx = 0;
    state.puck.vy = 0;

    const paddle = state.paddles[SLOT_LEFT]!;
    paddle.x = paddleBoundsX(SLOT_LEFT).minX;
    paddle.y = RINK_HEIGHT / 2;
    paddle.targetX = paddle.x;
    paddle.targetY = paddle.y;

    const after = step(state, IDLE);

    // The right player is credited, and play resets rather than stalling.
    expect(after.score[SLOT_RIGHT]).toBe(1);
    expect(after.freezeTicks).toBeGreaterThan(0);
    expect(after.puck.x).toBe(RINK_WIDTH / 2);
  });

  it('does not score a stationary puck outside the mouth', () => {
    const state = createInitialState();
    parkPaddles(state);
    state.puck.x = 6;
    state.puck.y = GOAL_Y_MIN - 30; // above the opening
    state.puck.vx = 0;
    state.puck.vy = 0;

    const after = step(state, IDLE);
    expect(after.score[SLOT_RIGHT]).toBe(0);
    expect(after.score[SLOT_LEFT]).toBe(0);
  });
});

describe('the puck cannot leave the rink', () => {
  /**
   * The failure this guards against ends the game silently.
   *
   * The swept solver cannot let the puck cross a wall, but positional
   * correction can: resolving an overlap displaces the puck along the contact
   * normal by whatever depth is needed, with no notion of walls. A paddle
   * pinning the puck against an end wall therefore squeezes it straight
   * through, and outside the goal mouth that scores nothing — so the puck stays
   * out there, drawn off canvas, and play continues with no puck at all.
   */
  it('does not let a paddle squeeze the puck through an end wall', () => {
    const state = createInitialState();
    parkPaddles(state);

    // Puck trapped between the left paddle and the end wall, above the mouth.
    const paddle = state.paddles[SLOT_LEFT]!;
    paddle.x = paddleBoundsX(SLOT_LEFT).minX;
    paddle.y = GOAL_Y_MIN - 60;
    paddle.targetX = 0; // driving hard into the wall
    paddle.targetY = paddle.y;

    state.puck.x = PUCK_RADIUS + 1;
    state.puck.y = paddle.y;
    state.puck.vx = 0;
    state.puck.vy = 0;

    let current = state;
    for (let i = 0; i < 120; i++) {
      current = step(current, IDLE);
      assertPuckContained(current, `pinned tick ${i}`);
    }

    // And still on the surface at the end, not merely within tolerance of it.
    expect(current.puck.x).toBeGreaterThan(0);
  });

  it('does not let a paddle squeeze the puck through a side wall', () => {
    const state = createInitialState();
    parkPaddles(state);

    const paddle = state.paddles[SLOT_LEFT]!;
    paddle.x = 200;
    paddle.y = PADDLE_RADIUS;
    paddle.targetX = 200;
    paddle.targetY = 0;

    state.puck.x = 200;
    state.puck.y = PUCK_RADIUS + 1;

    let current = state;
    for (let i = 0; i < 120; i++) {
      current = step(current, IDLE);
      assertPuckContained(current, `pinned tick ${i}`);
    }

    expect(current.puck.y).toBeGreaterThan(0);
  });
});

describe('paddle strikes', () => {
  it('does not let a full-speed puck tunnel through a stationary paddle', () => {
    const state = createInitialState();
    const paddle = state.paddles[SLOT_LEFT]!;
    // Line the puck up dead-centre on the paddle, just inside one tick of
    // travel. Derived from the speed ceiling rather than written as a literal,
    // so retuning the ceiling cannot silently turn this into a test of a puck
    // that never reached the paddle at all.
    const gap = ((PUCK_MAX_SPEED / TICK_RATE) * 4) / 5;
    paddle.targetX = paddle.x;
    paddle.targetY = paddle.y;
    state.puck.y = paddle.y;
    state.puck.x = paddle.x + PADDLE_RADIUS + PUCK_RADIUS + gap;
    state.puck.vx = -PUCK_MAX_SPEED;
    state.puck.vy = 0;

    const events: SimEvent[] = [];
    const after = step(state, IDLE, events);

    expect(events.some((e) => e.type === 'paddleHit' && e.slot === SLOT_LEFT)).toBe(true);
    expect(after.puck.vx).toBeGreaterThan(0); // repelled, not passed through
    expect(after.puck.x).toBeGreaterThan(paddle.x);
  });

  it('transfers paddle motion into the puck, so a driven shot outpaces a static rebound', () => {
    function shoot(paddleTargetX: number): number {
      const state = createInitialState();
      const paddle = state.paddles[SLOT_LEFT]!;
      state.puck.y = paddle.y;
      // Gap must be smaller than one tick of puck travel (200/60 ≈ 3.3 units),
      // or the strike simply does not happen inside the single step below.
      state.puck.x = paddle.x + PADDLE_RADIUS + PUCK_RADIUS + 2;
      state.puck.vx = -200; // drifting into the paddle
      state.puck.vy = 0;

      const inputs: InputSet = [{ seq: 1, targetX: paddleTargetX, targetY: paddle.y }, null];
      const after = step(state, inputs);
      return after.puck.vx;
    }

    const staticPaddle = shoot(createInitialState().paddles[SLOT_LEFT]!.x);
    const drivenPaddle = shoot(createInitialState().paddles[SLOT_LEFT]!.x + 500);

    expect(staticPaddle).toBeGreaterThan(0);
    expect(drivenPaddle).toBeGreaterThan(staticPaddle);
  });

  it('records the striking slot for transient authority', () => {
    const state = createInitialState();
    const paddle = state.paddles[SLOT_RIGHT]!;
    state.puck.y = paddle.y;
    // Inside one tick of travel (1200/60 = 20 units), so the strike lands in
    // the single step below.
    state.puck.x = paddle.x - PADDLE_RADIUS - PUCK_RADIUS - 10;
    state.puck.vx = 1200;
    state.puck.vy = 0;

    const after = step(state, IDLE);

    expect(after.lastTouchedBy).toBe(SLOT_RIGHT);
    expect(after.lastTouchTick).toBe(after.tick);
  });
});

describe('energy', () => {
  it('never gains speed while both paddles are stationary', () => {
    let state = stateWithPuckVelocity(900, 640);
    const initial = puckSpeed(state);

    for (let i = 0; i < 5000; i++) {
      state = step(state, IDLE);
      // Restitution below 1 plus friction means the puck can only ever lose energy.
      expect(puckSpeed(state)).toBeLessThanOrEqual(initial + 1e-6);
    }

    expect(puckSpeed(state)).toBeLessThan(initial);
  });
});

describe('sweepCircleVsCircle', () => {
  it('reports contact time for a head-on approach', () => {
    // A at origin moving right at 100/s, B stationary at x = 30, radii sum 10.
    // Contact when the gap of 30 closes to 10, i.e. after 0.2s.
    const t = sweepCircleVsCircle(0, 0, 100, 0, 30, 0, 0, 0, 10, 1);
    expect(t).toBeCloseTo(0.2, 10);
  });

  it('returns 0 when the circles already overlap', () => {
    expect(sweepCircleVsCircle(0, 0, 100, 0, 5, 0, 0, 0, 10, 1)).toBe(0);
  });

  it('returns -1 when the circles are separating', () => {
    expect(sweepCircleVsCircle(0, 0, -100, 0, 30, 0, 0, 0, 10, 1)).toBe(-1);
  });

  it('returns -1 for a near miss', () => {
    // Passing above B with a vertical offset larger than the radii sum.
    expect(sweepCircleVsCircle(0, 50, 100, 0, 30, 0, 0, 0, 10, 1)).toBe(-1);
  });

  it('returns -1 when contact falls beyond the time budget', () => {
    // Contact would occur at t = 0.2, outside a 0.1s window.
    expect(sweepCircleVsCircle(0, 0, 100, 0, 30, 0, 0, 0, 10, 0.1)).toBe(-1);
  });

  it('accounts for the second circle also moving', () => {
    // Both close at 100/s each: the 30-unit gap shrinks to 10 in 0.1s.
    const t = sweepCircleVsCircle(0, 0, 100, 0, 30, 0, -100, 0, 10, 1);
    expect(t).toBeCloseTo(0.1, 10);
  });
});
