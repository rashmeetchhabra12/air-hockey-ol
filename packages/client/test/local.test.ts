import { PERFECT_NETWORK, type NetworkConditions } from '@ah/protocol';
import { RINK_HEIGHT, RINK_WIDTH } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { LocalMatch } from '../src/local.js';

/**
 * The spectator mode, exercised without a browser.
 *
 * `LocalMatch` deliberately touches no DOM — it is the real `GameRoom`, the
 * real `ClientSession`, the real `Predictor` and the real codec, wired together
 * over the same simulated network the online client uses. That makes the thing
 * a visitor sees first testable in Node, which matters: it is the code path most
 * likely to be the *only* one anyone ever runs.
 *
 * Conditions are left perfect so delivery is synchronous. `withSimulatedNetwork`
 * only defers a packet when its computed delay is non-zero, so a zero-latency
 * link needs no timers and the match can be stepped deterministically.
 */
function perfect(): NetworkConditions {
  return { ...PERFECT_NETWORK };
}

function play(match: LocalMatch, ticks: number): void {
  for (let i = 0; i < ticks; i++) match.tick(i * (1000 / 60));
}

describe('LocalMatch', () => {
  it('starts a match with no server and no second human', () => {
    const match = new LocalMatch({ mode: 'spectate', conditions: perfect });
    play(match, 120);

    expect(match.ready).toBe(true);
    expect(match.room.occupancy).toBe(2);
    expect(match.room.getState().tick).toBeGreaterThan(100);
    match.dispose();
  });

  it('delivers snapshots to the rendered view', () => {
    const match = new LocalMatch({ mode: 'spectate', conditions: perfect });
    play(match, 200);

    const { buffer, predictor } = match.view();
    const newest = buffer.newest();

    expect(newest).not.toBeNull();
    expect(newest!.tick).toBeGreaterThan(0);
    // The client runs ahead of the server, which is what makes its own paddle
    // feel immediate.
    expect(predictor.getState().tick).toBeGreaterThanOrEqual(newest!.tick);
    match.dispose();
  });

  /**
   * The whole point of the mode: a visitor who arrives alone must see a game
   * being played, not a still image.
   */
  it('has the bots actually play', () => {
    const match = new LocalMatch({ mode: 'spectate', conditions: perfect });

    // Sampled across the run rather than read at the end: a goal resets both the
    // puck and `lastTouchedBy`, so a single reading taken just after one would
    // report a match that never started.
    let struck = false;
    let travelled = 0;
    let previous = { ...match.room.getState().puck };

    for (let i = 0; i < 1800; i++) {
      match.tick(i * (1000 / 60));
      const puck = match.room.getState().puck;
      if (match.room.getState().lastTouchedBy >= 0) struck = true;
      travelled += Math.abs(puck.x - previous.x) + Math.abs(puck.y - previous.y);
      previous = { ...puck };
    }

    expect(struck).toBe(true);
    expect(travelled).toBeGreaterThan(500);
    match.dispose();
  });

  it('gives the human a paddle in bot mode and leaves the other to the bot', () => {
    const match = new LocalMatch({ mode: 'bot', conditions: perfect });
    expect(match.humanSlot).toBe(0);

    match.setHumanTarget(420, 120);
    play(match, 200);

    const paddles = match.room.getState().paddles;
    // The human's paddle went where it was told...
    expect(paddles[0]!.x).toBeGreaterThan(300);
    expect(paddles[0]!.y).toBeLessThan(250);
    // ...and the opponent is being driven by something, not parked at spawn.
    expect(paddles[1]!.x).toBeGreaterThan(RINK_WIDTH / 2);
    match.dispose();
  });

  it('ignores human input while spectating', () => {
    const match = new LocalMatch({ mode: 'spectate', conditions: perfect });
    expect(match.humanSlot).toBeNull();
    expect(() => match.setHumanTarget(100, 100)).not.toThrow();
    play(match, 60);
    match.dispose();
  });

  it('keeps both paddles legal', () => {
    const match = new LocalMatch({ mode: 'spectate', conditions: perfect });

    for (let i = 0; i < 900; i++) {
      match.tick(i * (1000 / 60));
      const [a, b] = match.room.getState().paddles;
      expect(a!.x).toBeLessThan(RINK_WIDTH / 2);
      expect(b!.x).toBeGreaterThan(RINK_WIDTH / 2);
      expect(a!.y).toBeGreaterThan(0);
      expect(a!.y).toBeLessThan(RINK_HEIGHT);
    }
    match.dispose();
  });

  it('runs the real netcode, so the client leads the server', () => {
    const match = new LocalMatch({ mode: 'spectate', conditions: perfect });
    play(match, 400);

    const { predictor, buffer } = match.view();
    const lead = predictor.getState().tick - buffer.newest()!.tick;

    // Inputs are stamped with the tick they were simulated at, so the client
    // must be ahead or the server would receive them too late to use.
    expect(lead).toBeGreaterThan(0);
    match.dispose();
  });
});
