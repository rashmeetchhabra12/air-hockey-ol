import { PERFECT_NETWORK, type NetworkConditions } from '@ah/protocol';
import { PADDLE_RADIUS, PUCK_RADIUS } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { runScenario, type ScenarioConfig } from '../src/scenario.js';

function config(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    label: 'test',
    // Long enough to leave a real measurement window after warm-up, which now
    // waits for the pacer to settle on a lead rather than just for first
    // packets to arrive.
    seconds: 10,
    conditions: { ...PERFECT_NETWORK, rttMs: 150 } as NetworkConditions,
    mode: 'reliable-ordered',
    seed: 4242,
    netcode: true,
    ...overrides,
  };
}

/**
 * These run the whole stack — real room, real loop, real session, real
 * predictor and buffer — across a simulated network. They are slower than unit
 * tests and deliberately kept short, but they are the only tests that would
 * catch an integration mistake between components that are each individually
 * correct.
 */
describe('scenario harness', () => {
  it('is reproducible from its seed', () => {
    const a = runScenario(config());
    const b = runScenario(config());

    // A benchmark whose packet losses cannot be replayed is an anecdote.
    expect(b.paddleLagUnits).toEqual(a.paddleLagUnits);
    expect(b.puckDisplayLagMs).toEqual(a.puckDisplayLagMs);
    expect(b.bytesUpPerSecond).toBe(a.bytesUpPerSecond);
    expect(b.goals).toBe(a.goals);
  });

  it('produces different results for different seeds', () => {
    // Impairments must be enabled, or the seed only perturbs bot wobble and the
    // network behaves identically. Compared on metrics that actually vary —
    // paddle lag is pinned at zero by prediction and proves nothing here.
    const noisy = { rttMs: 120, jitterMs: 40, lossRate: 0.05, duplicateRate: 0.01 };
    const a = runScenario(config({ seed: 1, conditions: noisy }));
    const b = runScenario(config({ seed: 999, conditions: noisy }));

    expect(a.deliveryToClientMs.p99).toBeGreaterThan(0);
    expect(a.deliveryToClientMs.p99).not.toBe(b.deliveryToClientMs.p99);
  });

  /**
   * The project's headline claim, asserted rather than described.
   *
   * With prediction on, the paddle on screen must sit where a zero-latency
   * local game would have drawn it — regardless of round-trip time.
   */
  it.each([0, 100, 300])('keeps the paddle local-feeling at %ims RTT', (rttMs) => {
    const result = runScenario(
      config({ conditions: { ...PERFECT_NETWORK, rttMs }, netcode: true }),
    );

    // Sub-pixel at the median: indistinguishable from a local game, which is
    // the claim being made.
    expect(result.paddleLagUnits.p50).toBeLessThan(0.5);
    // The tail is bounded loosely and deliberately. At 300 ms it measures around
    // two paddle radii, and the source of that residue is not yet fully
    // characterised — steady-state late inputs, rewinds, and reconciliation
    // corrections all measure zero, so it is not any of the obvious candidates.
    // Asserting a tight bound here would be claiming an understanding this code
    // does not have.
    expect(result.paddleLagUnits.p99).toBeLessThan(PADDLE_RADIUS * 2.5);
  });

  it('shows the paddle falling behind without netcode', () => {
    const on = runScenario(config({ conditions: { ...PERFECT_NETWORK, rttMs: 300 }, netcode: true }));
    const off = runScenario(
      config({ conditions: { ...PERFECT_NETWORK, rttMs: 300 }, netcode: false }),
    );

    // The "before" half of the demo has to actually be worse, or the toggle
    // demonstrates nothing. Stated as absolutes rather than a ratio: with
    // prediction on the figure is near zero, and a ratio against near-zero is
    // dominated by whatever noise happens to be in the denominator.
    expect(off.paddleLagUnits.p50).toBeGreaterThan(50);
    expect(on.paddleLagUnits.p50).toBeLessThan(1);
  });

  /**
   * Puck display lag has a predictable value under strategy A: the fixed
   * interpolation delay plus half the round trip. Pinning it down means P4 and
   * P5 can be shown to reduce it rather than merely claimed to.
   */
  it.each([
    [0, 100],
    [100, 150],
    [200, 200],
  ])('renders the puck ~%ims behind under strategy A', (rttMs, expected) => {
    const result = runScenario(config({ conditions: { ...PERFECT_NETWORK, rttMs } }));
    expect(result.puckDisplayLagMs.p50).toBeGreaterThan(expected - 40);
    expect(result.puckDisplayLagMs.p50).toBeLessThan(expected + 40);
  });

  it('reconciles exactly on a clean link', () => {
    const result = runScenario(config({ conditions: { ...PERFECT_NETWORK, rttMs: 120 } }));

    // Replay reproduces the server's arithmetic, so there is nothing to correct.
    expect(result.correction.p99).toBe(0);
    expect(result.correctionsPerSecond).toBe(0);
  });

  it('keeps playing under hostile conditions', () => {
    const result = runScenario(
      config({
        seconds: 6,
        conditions: { rttMs: 300, jitterMs: 80, lossRate: 0.1, duplicateRate: 0.02 },
      }),
    );

    // Degraded, but not broken: still exchanging traffic and still simulating.
    expect(result.bytesUpPerSecond).toBeGreaterThan(0);
    expect(result.bytesDownPerSecond).toBeGreaterThan(0);
    expect(result.paddleLagUnits.p50).toBeLessThan(5);
    expect(result.starvedFrameRatio).toBeLessThan(0.5);
  });

  /**
   * The tradeoff the project exists to demonstrate, asserted rather than
   * described.
   *
   * Strategy A is showing real snapshot data, so it is never wrong about the
   * past — but the player is looking at *now*, and about that it is badly
   * wrong. Strategy B is drawn at the same instant as the local paddle, so it
   * is exactly right whenever the prediction holds.
   */
  it('strategy B is far more accurate about the present than strategy A', () => {
    const settings = { conditions: { ...PERFECT_NETWORK, rttMs: 200 }, seconds: 6 };

    const a = runScenario(config({ ...settings, puckStrategy: 'interpolate' }));
    const b = runScenario(config({ ...settings, puckStrategy: 'predict' }));

    // A is showing an older moment, so its error is roughly staleness x speed.
    expect(a.puckErrorUnits.p50).toBeGreaterThan(50);
    // B predicts to the instant it draws, so the median is essentially exact.
    expect(b.puckErrorUnits.p50).toBeLessThan(5);
    expect(b.puckErrorUnits.p50).toBeLessThan(a.puckErrorUnits.p50 / 10);
  });

  /**
   * And the cost of B, which is the reason C exists.
   *
   * The puck is influenced by an opponent whose input has not arrived, so the
   * prediction fails whenever they are playing it. That failure lands in the
   * tail, not the median — the puck is right until suddenly it is very wrong.
   */
  it('strategy B pays for its accuracy with a heavy tail', () => {
    const result = runScenario(
      config({
        conditions: { ...PERFECT_NETWORK, rttMs: 300 },
        seconds: 6,
        puckStrategy: 'predict',
      }),
    );

    expect(result.puckErrorUnits.p50).toBeLessThan(5);
    // Tens of puck-widths out at the tail: visible, and worth fixing in P5.
    expect(result.puckErrorUnits.p99).toBeGreaterThan(40);
  });

  /**
   * Strategy C's actual claim, which the aggregate hides.
   *
   * C is not uniformly better than B — it is better *where it matters*. While
   * this client owns the puck, meaning it is the one about to hit it, C
   * predicts and is as exact as B. While the opponent owns it, C shows real
   * data late rather than guessing, and the error is A-like.
   */
  it('gives strategy B accuracy while you own the puck, and A correctness while you do not', () => {
    // Measured at high latency deliberately. Since the interpolation delay
    // became adaptive it shrinks to about one snapshot interval on a good link,
    // which makes interpolation so accurate that the owned/unowned distinction
    // all but disappears below ~200 ms — a real improvement, but it leaves
    // nothing for this test to observe.
    const result = runScenario(
      config({
        conditions: { ...PERFECT_NETWORK, rttMs: 300 },
        seconds: 12,
        puckStrategy: 'authority',
      }),
    );

    // Authority must actually change hands, or this measures nothing.
    expect(result.puckOwnedRatio).toBeGreaterThan(0.1);
    expect(result.puckOwnedRatio).toBeLessThan(0.9);

    // The gap is the claim: the puck is markedly more accurate on the frames
    // this player is about to hit it than on the ones they are watching.
    //
    // The margin is narrower than it was before lag compensation, and for a
    // real reason rather than a regression in C. Tick-stamped inputs need the
    // client to run further ahead of the server, which means predicting further
    // ahead, and a prediction reaching further out is a worse prediction. That
    // is the cost of making late inputs land at the tick they were meant for.
    expect(result.puckErrorWhileOwned.p50).toBeLessThan(PUCK_RADIUS * 6);
    expect(result.puckErrorWhileNotOwned.p50).toBeGreaterThan(
      result.puckErrorWhileOwned.p50 * 2,
    );
  });

  /**
   * The other half of the tradeoff. B is the most accurate strategy and also
   * the one that visibly teleports most, because every failed prediction has to
   * be corrected on screen.
   */
  it('teleports the puck less often than always predicting it', () => {
    const settings = { conditions: { ...PERFECT_NETWORK, rttMs: 200 }, seconds: 8 };

    const interpolate = runScenario(config({ ...settings, puckStrategy: 'interpolate' }));
    const predict = runScenario(config({ ...settings, puckStrategy: 'predict' }));
    const authority = runScenario(config({ ...settings, puckStrategy: 'authority' }));

    // A only ever moves between real positions, so it essentially never jumps.
    expect(interpolate.puckJumpsPerSecond).toBeLessThan(predict.puckJumpsPerSecond);
    // C predicts only when the prediction is trustworthy, so it corrects less.
    expect(authority.puckJumpsPerSecond).toBeLessThan(predict.puckJumpsPerSecond);
  });

  it('never drops a packet under TCP semantics, and retransmits instead', () => {
    const result = runScenario(
      config({ mode: 'reliable-ordered', conditions: { ...PERFECT_NETWORK, rttMs: 100, lossRate: 0.08 } }),
    );

    expect(result.dropped).toBe(0);
    expect(result.retransmits).toBeGreaterThan(0);
  });
});
