import { snapshotFromState, type WireSnapshot } from '@ah/protocol';
import { createInitialState, RINK_WIDTH } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { INTERPOLATION_DELAY_MS, SnapshotBuffer } from '../src/index.js';

/** A snapshot with the puck and paddles placed exactly where the test wants them. */
function snapshotAt(
  tick: number,
  puckX: number,
  paddleX: number,
  score: [number, number] = [0, 0],
): WireSnapshot {
  const state = createInitialState();
  state.tick = tick;
  state.puck.x = puckX;
  state.paddles[0]!.x = paddleX;
  state.paddles[1]!.x = RINK_WIDTH - paddleX;
  state.score[0] = score[0];
  state.score[1] = score[1];
  return snapshotFromState(state, [tick, tick]);
}

describe('SnapshotBuffer interpolation', () => {
  it('returns nothing until a snapshot arrives', () => {
    expect(new SnapshotBuffer().sample(1000)).toBeNull();
  });

  it('interpolates halfway between two snapshots', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(0, 100, 100), 1000);
    buffer.push(snapshotAt(3, 200, 200), 1100);

    // Render time sits exactly between the two arrival times.
    const view = buffer.sample(1050 + INTERPOLATION_DELAY_MS);

    expect(view).not.toBeNull();
    expect(view!.puck.x).toBeCloseTo(150, 6);
    expect(view!.paddles[0]!.x).toBeCloseTo(150, 6);
    expect(view!.starved).toBe(false);
  });

  it('interpolates at an arbitrary fraction', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(0, 0, 0), 1000);
    buffer.push(snapshotAt(3, 400, 0), 1200);

    const view = buffer.sample(1050 + INTERPOLATION_DELAY_MS);
    // 50ms into a 200ms span is one quarter.
    expect(view!.puck.x).toBeCloseTo(100, 6);
  });

  /**
   * Rendering in the past is the entire mechanism: it guarantees two known-true
   * states bracket the render time, so remote motion is interpolated rather
   * than guessed.
   */
  it('renders the past, not the present', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(0, 0, 100), 1000);
    buffer.push(snapshotAt(3, 500, 100), 1000 + INTERPOLATION_DELAY_MS);

    // Sampling at the newest arrival time shows the *older* state, because the
    // render clock trails by the interpolation delay.
    const view = buffer.sample(1000 + INTERPOLATION_DELAY_MS);
    expect(view!.puck.x).toBeCloseTo(0, 6);
  });

  it('clamps and reports starvation when packets stop arriving', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(0, 100, 100), 1000);
    buffer.push(snapshotAt(3, 200, 100), 1050);

    // Render time has run far past the newest snapshot.
    const view = buffer.sample(5000);

    expect(view!.starved).toBe(true);
    // Clamped to the newest known state rather than extrapolated: inventing
    // motion here would only have to be undone.
    expect(view!.puck.x).toBeCloseTo(200, 6);
    expect(buffer.getStats().starvedFrames).toBeGreaterThan(0);
  });

  /**
   * A goal teleports the puck to centre. Blending across that would slide it
   * smoothly across the whole rink — which looks like a bug and hides the goal.
   */
  it('does not interpolate the puck across a goal', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(0, 40, 100, [0, 0]), 1000);
    buffer.push(snapshotAt(3, RINK_WIDTH / 2, 100, [0, 1]), 1100);

    const view = buffer.sample(1050 + INTERPOLATION_DELAY_MS);

    // Snapped to the post-goal position, not the midpoint of the teleport.
    expect(view!.puck.x).toBeCloseTo(RINK_WIDTH / 2, 6);
    expect(view!.score).toEqual([0, 1]);
    // Paddles did not teleport, so they still interpolate normally.
    expect(view!.paddles[0]!.x).toBeCloseTo(100, 6);
  });

  it('ignores duplicate snapshots', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(3, 100, 100), 1000);
    buffer.push(snapshotAt(3, 100, 100), 1010);
    expect(buffer.getStats().buffered).toBe(1);
  });

  it('accepts a reordered snapshot that is still useful', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(0, 0, 100), 1000);
    buffer.push(snapshotAt(6, 200, 100), 1100);
    // Jitter delivered tick 3 after tick 6.
    buffer.push(snapshotAt(3, 100, 100), 1110);

    expect(buffer.getStats().buffered).toBe(3);
    // Newest is still determined by tick, not arrival order.
    expect(buffer.newest()!.tick).toBe(6);
  });

  it('discards a snapshot that arrives too late to be used', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(30, 300, 100), 1000);
    buffer.push(snapshotAt(33, 330, 100), 1050);

    buffer.push(snapshotAt(3, 30, 100), 1100); // hopelessly stale

    expect(buffer.getStats().droppedLate).toBe(1);
    expect(buffer.getStats().buffered).toBe(2);
  });

  it('bounds its history', () => {
    const buffer = new SnapshotBuffer();
    for (let i = 0; i < 500; i++) {
      buffer.push(snapshotAt(i * 3, i, 100), 1000 + i * 50);
    }
    expect(buffer.getStats().buffered).toBeLessThanOrEqual(40);
    expect(buffer.newest()!.tick).toBe(499 * 3);
  });

  it('survives a single buffered snapshot', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshotAt(0, 123, 100), 1000);

    const view = buffer.sample(1000);
    expect(view!.puck.x).toBeCloseTo(123, 6);
    expect(view!.starved).toBe(true);
  });
});
