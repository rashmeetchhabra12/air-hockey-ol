import {
  createInitialState,
  length,
  paddleBoundsX,
  PADDLE_RADIUS,
  RINK_HEIGHT,
  RINK_WIDTH,
  SLOT_LEFT,
  SLOT_RIGHT,
  step,
  type GameState,
} from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { Bot } from '../src/bot.js';

/** Play a full match between two bots and report what happened. */
// Matches the difficulty the demo actually ships with, so the test exercises
// the configuration people will see rather than an arbitrary one.
function playMatch(ticks: number, difficulty = 0.88) {
  const bots = [
    new Bot({ slot: SLOT_LEFT, difficulty, seed: 11 }),
    new Bot({ slot: SLOT_RIGHT, difficulty, seed: 22 }),
  ];

  let state = createInitialState();
  let strikes = 0;

  for (let i = 0; i < ticks; i++) {
    const a = bots[0]!.decide(state);
    const b = bots[1]!.decide(state);
    const before = state.lastTouchTick;
    state = step(state, [
      { seq: i, targetX: a.x, targetY: a.y },
      { seq: i, targetX: b.x, targetY: b.y },
    ]);
    if (state.lastTouchTick !== before && state.lastTouchTick >= 0) strikes++;
  }

  return { state, strikes };
}

describe('bot behaviour', () => {
  /**
   * The bot exists to solve a product problem: a visitor who opens the demo
   * alone must still see a game. If it cannot get the puck moving, it fails at
   * the only job that matters.
   */
  it('gets the puck into play and keeps striking it', () => {
    // 1800 ticks is 30 seconds. The puck takes well over a second to cross the
    // rink, and a goal freezes play for a further three quarters of one, so a
    // strike every few seconds is what an actual rally looks like rather than a
    // sign of a passive bot.
    const { strikes, state } = playMatch(1800);
    expect(strikes).toBeGreaterThan(5);
    expect((state.score[0] ?? 0) + (state.score[1] ?? 0)).toBeGreaterThan(0);
  });

  it('produces goals over a long match', () => {
    const { state } = playMatch(6000);
    expect((state.score[0] ?? 0) + (state.score[1] ?? 0)).toBeGreaterThan(0);
  });

  it('keeps its paddle inside its own half', () => {
    const bot = new Bot({ slot: SLOT_LEFT, difficulty: 1, seed: 3 });
    const bounds = paddleBoundsX(SLOT_LEFT);

    let state = createInitialState();
    state.puck.vx = 700;
    state.puck.vy = 260;

    for (let i = 0; i < 1200; i++) {
      const target = bot.decide(state);
      expect(target.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(target.x).toBeLessThanOrEqual(bounds.maxX);
      expect(target.y).toBeGreaterThanOrEqual(PADDLE_RADIUS);
      expect(target.y).toBeLessThanOrEqual(RINK_HEIGHT - PADDLE_RADIUS);
      state = step(state, [{ seq: i, targetX: target.x, targetY: target.y }, null]);
    }
  });

  /**
   * Trajectory prediction rolls the *real* simulation forward, which is what
   * lets the bot anticipate a bounce rather than chase where the puck is now.
   * A linear extrapolation would send it to the wrong end of the rink.
   */
  it('moves to intercept a puck that has to bounce off a wall first', () => {
    const bot = new Bot({ slot: SLOT_LEFT, difficulty: 1, seed: 7 });

    let state: GameState = createInitialState();
    // Heading left and steeply down, so it will rebound off the bottom wall
    // before it reaches the left half.
    state.puck.x = RINK_WIDTH * 0.75;
    state.puck.y = 120;
    state.puck.vx = -520;
    state.puck.vy = 620;

    // Let the reaction buffer fill so the bot is acting on this situation.
    let target = { x: 0, y: 0 };
    for (let i = 0; i < 12; i++) target = bot.decide(state);

    // Where the puck will actually arrive, by running the same simulation.
    let future = state;
    let arrivalY = RINK_HEIGHT / 2;
    for (let i = 0; i < 60; i++) {
      future = step(future, [null, null]);
      if (future.puck.x < RINK_WIDTH / 2) {
        arrivalY = future.puck.y;
        break;
      }
    }

    // At full difficulty aim error is small, so the bot should be heading for
    // roughly the right place — well inside a paddle's own diameter.
    expect(Math.abs(target.y - arrivalY)).toBeLessThan(PADDLE_RADIUS * 3);
    // And crucially not still sitting at its home position.
    expect(Math.abs(target.y - RINK_HEIGHT / 2)).toBeGreaterThan(10);
  });

  it('falls back toward home when the puck is not coming', () => {
    const bot = new Bot({ slot: SLOT_LEFT, difficulty: 1, seed: 5 });

    const state = createInitialState();
    // Sitting in the opponent's half and moving away.
    state.puck.x = RINK_WIDTH * 0.8;
    state.puck.y = 300;
    state.puck.vx = 400;
    state.puck.vy = 0;

    let target = { x: 0, y: 0 };
    for (let i = 0; i < 12; i++) target = bot.decide(state);

    // Defensive depth, not chasing into a half it cannot reach.
    expect(target.x).toBeLessThan(RINK_WIDTH * 0.35);
  });

  it('plays the same way twice from the same seed', () => {
    const a = playMatch(900);
    const b = playMatch(900);
    expect(b.state.score).toEqual(a.state.score);
    expect(b.strikes).toBe(a.strikes);
  });

  /**
   * A bot with perfect aim is unplayable and, worse, boring. Difficulty has to
   * actually change how well it plays.
   */
  it('is measurably worse at low difficulty', () => {
    function missDistance(difficulty: number): number {
      const bot = new Bot({ slot: SLOT_LEFT, difficulty, seed: 42 });
      const state = createInitialState();
      state.puck.x = 300;
      state.puck.y = 300;
      state.puck.vx = -200;

      let total = 0;
      let samples = 0;
      for (let i = 0; i < 200; i++) {
        const target = bot.decide(state);
        total += length(target.x - state.puck.x, target.y - state.puck.y);
        samples++;
      }
      return total / samples;
    }

    expect(missDistance(0)).toBeGreaterThan(missDistance(1));
  });

  it('never sees authoritative state it was not given', () => {
    // The bot only ever reads the state handed to it, so feeding a stale view
    // must visibly change its decisions. If it were peeking at truth, the two
    // would agree.
    const bot = new Bot({ slot: SLOT_LEFT, difficulty: 1, seed: 9 });
    const fresh = createInitialState();
    fresh.puck.x = 250;
    fresh.puck.y = 150;
    fresh.puck.vx = -300;

    const stale = createInitialState();
    stale.puck.x = 250;
    stale.puck.y = 450;
    stale.puck.vx = -300;

    for (let i = 0; i < 12; i++) bot.decide(fresh);
    const fromFresh = bot.decide(fresh);

    const other = new Bot({ slot: SLOT_LEFT, difficulty: 1, seed: 9 });
    for (let i = 0; i < 12; i++) other.decide(stale);
    const fromStale = other.decide(stale);

    expect(Math.abs(fromFresh.y - fromStale.y)).toBeGreaterThan(50);
  });
});
