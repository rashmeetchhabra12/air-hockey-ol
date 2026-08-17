import { snapshotFromState, type WireSnapshot } from '@ah/protocol';
import { createInitialState, length, RINK_HEIGHT, RINK_WIDTH } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import type { InterpolatedView } from '../src/interpolation.js';
import { Predictor } from '../src/prediction.js';
import {
  maxPlausibleFrameTravel,
  PuckSmoother,
  resolvePuck,
  type PuckResolution,
} from '../src/puck.js';

/**
 * Ticks must advance between snapshots: the predictor refuses any that does not
 * describe a later tick than one already applied, because on a jittery link an
 * older snapshot arriving late would otherwise rewind the prediction.
 */
function snapshotWithPuck(
  x: number,
  y: number,
  options: { tick?: number; ack?: number; owner?: number } = {},
): WireSnapshot {
  const state = createInitialState();
  state.tick = options.tick ?? 0;
  state.puck.x = x;
  state.puck.y = y;
  state.puckOwner = options.owner ?? -1;
  const ack = options.ack ?? -1;
  return snapshotFromState(state, [ack, ack]);
}

function predictorAt(x: number, y: number, owner = -1): Predictor {
  const predictor = new Predictor(0);
  predictor.resync(snapshotWithPuck(x, y, { tick: 0, owner }));
  return predictor;
}

const interpolatedAt = (x: number, y: number): InterpolatedView => ({
  paddles: [
    { x: 200, y: 300 },
    { x: 800, y: 300 },
  ],
  puck: { x, y },
  score: [0, 0],
  starved: false,
});

describe('puck strategy selection', () => {
  it('A draws the puck from interpolated snapshots', () => {
    const predictor = predictorAt(100, 100);
    const result = resolvePuck('interpolate', predictor, interpolatedAt(700, 400), 0);

    expect(result.source).toBe('interpolated');
    expect(result.position).toEqual({ x: 700, y: 400 });
  });

  it('B draws the puck from the prediction', () => {
    const predictor = predictorAt(100, 100);
    const result = resolvePuck('predict', predictor, interpolatedAt(700, 400), 0);

    expect(result.source).toBe('predicted');
    expect(result.position.x).toBeCloseTo(100, 6);
    expect(result.position.y).toBeCloseTo(100, 6);
  });

  /**
   * C's whole idea: predict the puck only while this client is the one playing
   * it. When the opponent has it, their inputs decide what happens and we have
   * not seen them, so real-but-late data beats a confident guess.
   */
  it('C predicts while it owns the puck and interpolates otherwise', () => {
    const owned = predictorAt(100, 100, 0);
    const owning = resolvePuck('authority', owned, interpolatedAt(700, 400), 0);
    expect(owning.source).toBe('predicted');
    expect(owning.owner).toBe(0);

    // Opponent owns it: their input decides what happens next, and we have not
    // seen it, so real-but-late data beats a confident guess.
    const opponents = predictorAt(100, 100, 1);
    const notOwning = resolvePuck('authority', opponents, interpolatedAt(700, 400), 0);
    expect(notOwning.source).toBe('interpolated');
    expect(notOwning.position).toEqual({ x: 700, y: 400 });

    // Contested (owner -1) is also not ours to predict.
    const contested = predictorAt(100, 100, -1);
    expect(resolvePuck('authority', contested, interpolatedAt(700, 400), 0).source).toBe(
      'interpolated',
    );
  });

  it('falls back to the prediction before any snapshot can be interpolated', () => {
    const predictor = predictorAt(500, 300);

    for (const strategy of ['interpolate', 'authority'] as const) {
      const result = resolvePuck(strategy, predictor, null, 0);
      expect(result.source).toBe('predicted');
      expect(result.position.x).toBeCloseTo(500, 6);
    }
  });
});

describe('puck correction handling', () => {
  /**
   * A modest disagreement is drift and should be eased away, exactly as paddle
   * corrections are — snapping it would make every contested tick visible as a
   * flicker.
   */
  it('smooths a small disagreement instead of snapping', () => {
    const predictor = predictorAt(500, 300);
    const before = predictor.getRenderedPuck();

    // Server says the puck is 20 units away from the prediction.
    predictor.reconcile(snapshotWithPuck(520, 300, { tick: 3 }));

    const stats = predictor.getStats();
    expect(stats.lastPuckErrorUnits).toBeCloseTo(20, 6);
    expect(stats.puckCorrections).toBe(1);
    expect(stats.puckSnaps).toBe(0);

    // Simulation took the correction; the picture has not jumped yet.
    expect(predictor.getState().puck.x).toBeCloseTo(520, 6);
    const justAfter = predictor.getRenderedPuck();
    expect(length(justAfter.x - before.x, justAfter.y - before.y)).toBeLessThan(0.001);

    // ...and closes the gap over the next few frames.
    for (let t = 0; t < 1500; t += 16) predictor.decayCorrection(16);
    const settled = predictor.getRenderedPuck();
    expect(settled.x).toBeCloseTo(520, 3);
  });

  /**
   * A goal teleports the puck to centre, and a contested collision can resolve
   * hundreds of units away. Blending across that would send the puck gliding
   * over the rink to catch up — which reads as a bug and hides the event.
   */
  it('snaps a large disagreement rather than gliding across it', () => {
    const predictor = predictorAt(60, 300);

    // The server scored and reset the puck to centre.
    predictor.reconcile(snapshotWithPuck(RINK_WIDTH / 2, RINK_HEIGHT / 2, { tick: 3 }));

    const stats = predictor.getStats();
    expect(stats.puckSnaps).toBe(1);
    expect(stats.puckCorrections).toBe(0);

    // No residual offset: the picture is at the new truth immediately.
    const rendered = predictor.getRenderedPuck();
    expect(rendered.x).toBeCloseTo(RINK_WIDTH / 2, 6);
    expect(rendered.y).toBeCloseTo(RINK_HEIGHT / 2, 6);
  });

  it('reports no puck disagreement when the prediction was right', () => {
    const predictor = predictorAt(400, 250);
    predictor.reconcile(snapshotWithPuck(400, 250, { tick: 3 }));

    expect(predictor.getStats().lastPuckErrorUnits).toBe(0);
    expect(predictor.getStats().puckCorrections).toBe(0);
    expect(predictor.getStats().puckSnaps).toBe(0);
  });

  it('clears the puck offset on resync', () => {
    const predictor = predictorAt(500, 300);
    predictor.reconcile(snapshotWithPuck(515, 300, { tick: 3 }));
    expect(predictor.getRenderedPuck().x).not.toBeCloseTo(515, 3);

    predictor.resync(snapshotWithPuck(700, 200, { tick: 9 }));
    const rendered = predictor.getRenderedPuck();
    expect(rendered.x).toBeCloseTo(700, 6);
    expect(rendered.y).toBeCloseTo(200, 6);
  });
});

describe('handoff smoothing', () => {
  const at = (x: number, source: 'predicted' | 'interpolated'): PuckResolution => ({
    position: { x, y: 300 },
    source,
    owner: source === 'predicted' ? 0 : 1,
  });

  /**
   * Predicted and interpolated positions describe the same puck at instants
   * roughly a round trip apart, so changing source teleports it. The logic
   * switches immediately; the picture must not.
   */
  it('hides the jump when the puck changes source', () => {
    const smoother = new PuckSmoother();

    smoother.apply(at(500, 'predicted'), 16);
    const beforeHandoff = smoother.apply(at(510, 'predicted'), 16);

    // Authority moves to the opponent; the interpolated puck is 200 units back.
    const justAfter = smoother.apply(at(310, 'interpolated'), 16);

    expect(smoother.handoffs).toBe(1);
    // Barely moved on screen, despite a 200-unit change of source.
    expect(Math.abs(justAfter.x - beforeHandoff.x)).toBeLessThan(30);

    // Converges on the new source over the following frames.
    let settled = justAfter;
    for (let i = 0; i < 120; i++) settled = smoother.apply(at(310, 'interpolated'), 16);
    expect(settled.x).toBeCloseTo(310, 1);
  });

  /**
   * The bug this replaced: keying the blend on the ownership *epoch* fired on
   * every authority change, including ones this client never renders. Under
   * strategy B the source is always the prediction, so an epoch-keyed blend
   * injected a correction on almost every frame and degraded the median from
   * exact to several units.
   */
  it('does not blend when only the owner changed, not the source', () => {
    const smoother = new PuckSmoother();

    smoother.apply(at(500, 'predicted'), 16);
    // Ownership churns, but this client is predicting throughout.
    const shown = smoother.apply({ ...at(520, 'predicted'), owner: 1 }, 16);

    expect(smoother.handoffs).toBe(0);
    expect(shown.x).toBeCloseTo(520, 6);
  });

  it('does not blend on the very first frame', () => {
    const smoother = new PuckSmoother();
    const first = smoother.apply(at(700, 'interpolated'), 16);
    expect(smoother.handoffs).toBe(0);
    expect(first.x).toBeCloseTo(700, 6);
  });

  it('decays at the same rate regardless of frame rate', () => {
    function residual(frameMs: number): number {
      const smoother = new PuckSmoother();
      smoother.apply(at(500, 'predicted'), frameMs);
      // Zero elapsed time on the handoff frame, so both runs decay over exactly
      // 200 ms rather than 200 ms plus one frame of whatever size.
      smoother.apply(at(300, 'interpolated'), 0);

      const steps = 200 / frameMs;
      let shown = { x: 0, y: 0 };
      for (let i = 0; i < steps; i++) shown = smoother.apply(at(300, 'interpolated'), frameMs);
      return shown.x - 300;
    }

    // Approximate rather than exact, and necessarily so: the blend is
    // exponential until it hits the catch-up rate cap and linear afterwards,
    // and the frame on which it crosses over depends on frame size. Within a
    // percent is far tighter than anything visible.
    const coarse = residual(20);
    const fine = residual(5);
    expect(Math.abs(coarse - fine) / Math.abs(fine)).toBeLessThan(0.01);
  });

  /**
   * A handoff spans roughly a round trip of puck travel — hundreds of units at
   * speed. Easing that away on a fixed time constant alone would move the puck
   * several times faster than a puck can physically go, producing exactly the
   * visible teleport the blend exists to prevent.
   */
  it('never closes a gap faster than a puck could plausibly travel', () => {
    const smoother = new PuckSmoother();
    const frameMs = 1000 / 60;

    smoother.apply(at(900, 'predicted'), frameMs);
    // Authority moves away; the interpolated puck is most of the rink back.
    let previous = smoother.apply(at(200, 'interpolated'), frameMs);

    for (let i = 0; i < 60; i++) {
      const next = smoother.apply(at(200, 'interpolated'), frameMs);
      const moved = Math.abs(next.x - previous.x);
      expect(moved).toBeLessThanOrEqual(maxPlausibleFrameTravel(frameMs));
      previous = next;
    }
  });

  it('forgets its history on reset', () => {
    const smoother = new PuckSmoother();
    smoother.apply(at(500, 'predicted'), 16);
    smoother.reset();

    const shown = smoother.apply(at(200, 'interpolated'), 16);
    expect(smoother.handoffs).toBe(0);
    expect(shown.x).toBeCloseTo(200, 6);
  });
});
