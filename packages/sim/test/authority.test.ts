import { describe, expect, it } from 'vitest';

import { computePuckOwner, updatePuckAuthority } from '../src/authority.js';
import {
  AUTHORITY_HYSTERESIS,
  PADDLE_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
  SLOT_LEFT,
  SLOT_RIGHT,
} from '../src/config.js';
import { createInitialState, paddleBoundsX } from '../src/state.js';
import { step } from '../src/step.js';
import type { GameState } from '../src/types.js';

const LINE = RINK_WIDTH / 2;

/** State with the puck placed exactly where a test wants it and paddles parked away. */
function withPuckAt(x: number, y = RINK_HEIGHT / 2): GameState {
  const state = createInitialState();
  state.puck.x = x;
  state.puck.y = y;
  // Park both paddles in the far corners of their own halves so that no test is
  // accidentally measuring the contested rule when it means to measure position.
  for (const slot of [SLOT_LEFT, SLOT_RIGHT]) {
    const bounds = paddleBoundsX(slot);
    const paddle = state.paddles[slot]!;
    paddle.x = slot === SLOT_LEFT ? bounds.minX : bounds.maxX;
    paddle.y = RINK_HEIGHT - PADDLE_RADIUS;
    paddle.targetX = paddle.x;
    paddle.targetY = paddle.y;
  }
  return state;
}

/**
 * Authority answers one question: *is this client's own input what decides what
 * the puck does next?* Everything below is that question in a specific
 * situation.
 */
describe('puck authority', () => {
  it('gives the puck to whichever half it is in', () => {
    expect(computePuckOwner(withPuckAt(200))).toBe(SLOT_LEFT);
    expect(computePuckOwner(withPuckAt(800))).toBe(SLOT_RIGHT);
  });

  /**
   * Without hysteresis a puck loitering on the line flips ownership every few
   * ticks, and each flip moves the client between predicting the puck and
   * interpolating it — two timelines roughly a round trip apart. The result is
   * a puck that stutters exactly when players are watching it most closely.
   */
  it('keeps an established owner until the puck clearly leaves their half', () => {
    const state = withPuckAt(LINE + AUTHORITY_HYSTERESIS - 10);
    state.puckOwner = SLOT_LEFT;

    // Over the line, but not far enough to change hands.
    expect(computePuckOwner(state)).toBe(SLOT_LEFT);

    state.puck.x = LINE + AUTHORITY_HYSTERESIS + 10;
    expect(computePuckOwner(state)).toBe(SLOT_RIGHT);
  });

  it('applies hysteresis symmetrically', () => {
    const state = withPuckAt(LINE - AUTHORITY_HYSTERESIS + 10);
    state.puckOwner = SLOT_RIGHT;
    expect(computePuckOwner(state)).toBe(SLOT_RIGHT);

    state.puck.x = LINE - AUTHORITY_HYSTERESIS - 10;
    expect(computePuckOwner(state)).toBe(SLOT_LEFT);
  });

  /**
   * The moment the other paddle is close enough to strike, this player's input
   * no longer decides the outcome — so nobody may predict it, and both clients
   * fall back to real data.
   */
  it('gives the puck to nobody when the opposing paddle can reach it', () => {
    const state = withPuckAt(LINE - 20);
    // Slot 1's paddle is pinned at the centre line and right next to the puck.
    const opponent = state.paddles[SLOT_RIGHT]!;
    opponent.x = paddleBoundsX(SLOT_RIGHT).minX;
    opponent.y = state.puck.y;

    expect(computePuckOwner(state)).toBe(-1);
  });

  it('gives the puck to nobody during the post-goal freeze', () => {
    const state = withPuckAt(200);
    state.freezeTicks = 10;
    expect(computePuckOwner(state)).toBe(-1);
  });

  it('bumps the epoch only when ownership actually changes', () => {
    const state = withPuckAt(200);

    updatePuckAuthority(state);
    expect(state.puckOwner).toBe(SLOT_LEFT);
    const afterFirst = state.puckOwnerEpoch;
    expect(afterFirst).toBe(1);

    // Same owner on the next tick: no version change.
    updatePuckAuthority(state);
    expect(state.puckOwnerEpoch).toBe(afterFirst);

    state.puck.x = 900;
    updatePuckAuthority(state);
    expect(state.puckOwner).toBe(SLOT_RIGHT);
    expect(state.puckOwnerEpoch).toBe(afterFirst + 1);
  });
});

describe('authority through the simulation', () => {
  it('is derived every tick rather than claimed', () => {
    let state = createInitialState();
    state.puck.x = 200;
    state.puck.vx = 0;
    state = step(state, [null, null]);

    // No client said anything; the server worked it out from the state it holds.
    expect(state.puckOwner).toBe(SLOT_LEFT);
  });

  /**
   * Ownership is part of the simulation, so two independent runs of the same
   * inputs must agree about it — otherwise clients would disagree about who may
   * predict, and both could predict at once.
   */
  it('is deterministic across identical runs', () => {
    function run(): number[] {
      let state = createInitialState();
      state.puck.vx = 620;
      state.puck.vy = -370;
      const owners: number[] = [];
      for (let i = 0; i < 900; i++) {
        state = step(state, [
          { seq: i, targetX: 250 + (i % 40) * 5, targetY: 200 + (i % 30) * 8 },
          { seq: i, targetX: 750 - (i % 35) * 6, targetY: 400 - (i % 25) * 7 },
        ]);
        owners.push(state.puckOwner);
      }
      return owners;
    }

    expect(run()).toEqual(run());
  });

  it('hands the puck over as it crosses the rink', () => {
    let state = createInitialState();
    // Send the puck from the left half toward the right, clear of both paddles.
    state.puck.x = 260;
    state.puck.y = 90;
    state.puck.vx = 700;
    state.puck.vy = 0;

    const seen = new Set<number>();
    for (let i = 0; i < 90; i++) {
      state = step(state, [null, null]);
      seen.add(state.puckOwner);
    }

    expect(seen.has(SLOT_LEFT)).toBe(true);
    expect(seen.has(SLOT_RIGHT)).toBe(true);
    expect(state.puckOwnerEpoch).toBeGreaterThan(0);
  });
});
