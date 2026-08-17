import { snapshotFromState, type WireSnapshot } from '@ah/protocol';
import {
  cloneState,
  createInitialState,
  hashState,
  length,
  step,
  type GameState,
  type PlayerInput,
} from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { Predictor } from '../src/index.js';

/**
 * A scripted stream of player intent.
 *
 * Targets sweep across the rink rather than jittering in place, so paddles
 * travel real distances and actually strike the puck — a script that keeps the
 * paddle still would make prediction trivially correct and prove nothing.
 */
function buildInputs(count: number): PlayerInput[] {
  const inputs: PlayerInput[] = [];
  for (let i = 0; i < count; i++) {
    inputs.push({
      seq: i,
      targetX: 240 + Math.sin(i / 11) * 180,
      targetY: 300 + Math.cos(i / 7) * 220,
    });
  }
  return inputs;
}

/** Reference timeline: the same inputs applied continuously, with no networking. */
function simulateReference(inputs: PlayerInput[], initial: GameState): GameState {
  let state = initial;
  for (const input of inputs) {
    state = step(state, [input, null]);
  }
  return state;
}

interface HarnessOptions {
  /** Ticks of delay before the server consumes an input. */
  lagTicks: number;
  /** Ticks between snapshots. */
  snapshotInterval: number;
  totalTicks: number;
  /** Snapshot indices to drop, simulating packet loss. */
  dropSnapshots?: (index: number) => boolean;
}

/**
 * Drive a predictor against a server that lags behind it.
 *
 * Deliberately synchronous and timer-free: the property under test is
 * arithmetic, not timing, and a test that depended on wall-clock scheduling
 * would be flaky for reasons unrelated to netcode.
 */
function runHarness(options: HarnessOptions): {
  predictor: Predictor;
  reference: GameState;
  server: GameState;
} {
  const { lagTicks, snapshotInterval, totalTicks } = options;
  const inputs = buildInputs(totalTicks);

  const initial = createInitialState();
  initial.puck.vx = 320;
  initial.puck.vy = -210;

  const predictor = new Predictor(0);
  predictor.resync(snapshotFromState(initial, [-1, -1]));

  let server = initial;
  let lastConsumed = -1;
  let snapshotIndex = 0;

  for (let tick = 0; tick < totalTicks; tick++) {
    predictor.predict(inputs[tick]!);

    // The server consumes inputs `lagTicks` later than the client issued them.
    const serverInputIndex = tick - lagTicks;
    if (serverInputIndex >= 0) {
      const serverInput = inputs[serverInputIndex]!;
      server = step(server, [serverInput, null]);
      lastConsumed = serverInput.seq;

      if (server.tick % snapshotInterval === 0) {
        const drop = options.dropSnapshots?.(snapshotIndex++) ?? false;
        if (!drop) {
          predictor.reconcile(snapshotFromState(server, [lastConsumed, -1]));
        }
      }
    }
  }

  return {
    predictor,
    reference: simulateReference(inputs, initial),
    server,
  };
}

describe('reconciliation correctness', () => {
  /**
   * The strongest statement available about this code.
   *
   * Reconciliation discards the prediction, adopts authoritative state, and
   * replays the unacknowledged inputs. Because `step()` is deterministic and
   * both sides run the identical module, the combined sequence of inputs
   * applied is exactly the uninterrupted one — so the result must be
   * bit-identical to a simulation that never involved a network at all.
   *
   * "Close enough" would be a much weaker property, and a much weaker test: it
   * would pass while a real divergence quietly accumulated.
   */
  it('converges to a bit-identical state with an uninterrupted simulation', () => {
    const { predictor, reference } = runHarness({
      lagTicks: 12,
      snapshotInterval: 3,
      totalTicks: 600,
    });

    expect(hashState(predictor.getState())).toBe(hashState(reference));
  });

  it.each([1, 6, 12, 30, 60])('converges at a lag of %i ticks', (lagTicks) => {
    const { predictor, reference } = runHarness({
      lagTicks,
      snapshotInterval: 3,
      totalTicks: 400,
    });

    expect(hashState(predictor.getState())).toBe(hashState(reference));
  });

  it('converges when most snapshots are lost', () => {
    // Only every fifth snapshot survives. Reconciliation is less frequent, but
    // each one still replays a correct input tail.
    const { predictor, reference } = runHarness({
      lagTicks: 15,
      snapshotInterval: 3,
      totalTicks: 500,
      dropSnapshots: (i) => i % 5 !== 0,
    });

    expect(hashState(predictor.getState())).toBe(hashState(reference));
  });

  it('leaves the prediction ahead of the server by roughly the lag', () => {
    const lagTicks = 20;
    const { predictor, server } = runHarness({
      lagTicks,
      snapshotInterval: 3,
      totalTicks: 400,
    });

    // The prediction represents "now"; the server state represents the past.
    expect(predictor.getState().tick - server.tick).toBe(lagTicks);
  });

  it('holds roughly one round trip of inputs outstanding', () => {
    const lagTicks = 18;
    const { predictor } = runHarness({ lagTicks, snapshotInterval: 3, totalTicks: 400 });

    const unacked = predictor.getStats().unackedInputs;
    // Snapshots arrive every 3 ticks, so the count oscillates around the lag.
    expect(unacked).toBeGreaterThanOrEqual(lagTicks);
    expect(unacked).toBeLessThanOrEqual(lagTicks + 3);
  });
});

describe('correction behaviour', () => {
  /**
   * When client and server agree, reconciliation must be invisible. This is the
   * normal case in a healthy connection, and it is why correct netcode looks
   * like no netcode at all.
   */
  it('reports no correction while the prediction is accurate', () => {
    const { predictor } = runHarness({ lagTicks: 10, snapshotInterval: 3, totalTicks: 300 });

    const stats = predictor.getStats();
    expect(stats.reconciliations).toBeGreaterThan(50);
    expect(stats.lastErrorUnits).toBe(0);
    expect(stats.corrections).toBe(0);
  });

  /**
   * When the server disagrees — here because it never received the input at all
   * — the correction must be detected and taken into the visual offset rather
   * than snapped on screen.
   */
  it('detects and smooths a genuine disagreement', () => {
    const predictor = new Predictor(0);
    const initial = createInitialState();
    predictor.resync(snapshotFromState(initial, [-1, -1]));

    // Client predicts a long move that the server knows nothing about.
    for (let i = 0; i < 30; i++) {
      predictor.predict({ seq: i, targetX: 460, targetY: 80 });
    }
    const predicted = predictor.getRenderedSelf();

    // Server acknowledges every input but never actually applied them. The
    // snapshot must describe a later tick than the resync, or the predictor
    // refuses it as a reordered duplicate.
    const later = cloneState(initial);
    later.tick = 30;
    predictor.reconcile(snapshotFromState(later, [29, -1]));

    const stats = predictor.getStats();
    expect(stats.corrections).toBe(1);
    expect(stats.lastErrorUnits).toBeGreaterThan(10);

    // The simulation took the correction immediately...
    expect(predictor.getState().paddles[0]!.x).toBeCloseTo(initial.paddles[0]!.x, 6);

    // ...but the rendered position has not jumped; it still sits near where the
    // player last saw it, and closes the gap over the next few frames.
    const renderedNow = predictor.getRenderedSelf();
    expect(length(renderedNow.x - predicted.x, renderedNow.y - predicted.y)).toBeLessThan(0.001);

    // A ~240-unit correction needs about a second to fall inside the dead zone
    // at a 110 ms time constant; 1.5 s leaves margin.
    let elapsed = 0;
    while (elapsed < 1500) {
      predictor.decayCorrection(16);
      elapsed += 16;
    }

    const settled = predictor.getRenderedSelf();
    expect(settled.x).toBeCloseTo(predictor.getState().paddles[0]!.x, 3);
    expect(settled.y).toBeCloseTo(predictor.getState().paddles[0]!.y, 3);
  });

  it('decays corrections at the same rate regardless of frame rate', () => {
    function settleWith(frameMs: number): number {
      const predictor = new Predictor(0);
      const initial = createInitialState();
      predictor.resync(snapshotFromState(initial, [-1, -1]));
      for (let i = 0; i < 20; i++) predictor.predict({ seq: i, targetX: 460, targetY: 100 });
      const later = cloneState(initial);
      later.tick = 20;
      predictor.reconcile(snapshotFromState(later, [19, -1]));

      const before = predictor.getRenderedSelf();
      // Frame sizes chosen to divide 100 ms exactly, so both runs cover
      // identical wall time — otherwise the test measures its own loop bound
      // rather than the decay.
      const steps = 100 / frameMs;
      for (let i = 0; i < steps; i++) predictor.decayCorrection(frameMs);
      const after = predictor.getRenderedSelf();
      return length(after.x - before.x, after.y - before.y);
    }

    // 50 Hz versus 200 Hz: the same 100 ms of wall time must produce the same
    // visual catch-up, or a correction would look different on different
    // monitors.
    expect(settleWith(20)).toBeCloseTo(settleWith(5), 6);
  });
});

describe('snapshot ordering', () => {
  /**
   * Jitter reorders packets, so a snapshot describing tick 100 can land after
   * one describing tick 103. Applying it would rewind the prediction to older
   * authoritative state and discard newer information already folded in.
   *
   * Replay would still converge — it is deterministic — but the remote paddle
   * would regress to a stale position and be carried forward by "keep seeking
   * the last known target" rather than by the real data already received. That
   * is strictly worse, and costs a full replay to achieve.
   */
  it('refuses a snapshot that describes an earlier tick than one already applied', () => {
    const predictor = new Predictor(0);
    const initial = createInitialState();
    predictor.resync(snapshotFromState(initial, [-1, -1]));

    for (let i = 0; i < 20; i++) predictor.predict({ seq: i, targetX: 420, targetY: 150 });

    const newer = cloneState(initial);
    newer.tick = 103;
    newer.puck.x = 700;
    predictor.reconcile(snapshotFromState(newer, [10, -1]));
    expect(predictor.getState().tick).toBeGreaterThanOrEqual(103);
    const afterNewer = hashState(predictor.getState());

    // The reordered straggler.
    const older = cloneState(initial);
    older.tick = 100;
    older.puck.x = 100;
    predictor.reconcile(snapshotFromState(older, [7, -1]));

    expect(predictor.getStats().staleSnapshotsIgnored).toBe(1);
    expect(hashState(predictor.getState())).toBe(afterNewer);
  });

  it('accepts snapshots that keep moving forward', () => {
    const predictor = new Predictor(0);
    const initial = createInitialState();
    predictor.resync(snapshotFromState(initial, [-1, -1]));

    for (const tick of [10, 20, 30]) {
      const snap = cloneState(initial);
      snap.tick = tick;
      predictor.reconcile(snapshotFromState(snap, [-1, -1]));
    }

    expect(predictor.getStats().staleSnapshotsIgnored).toBe(0);
    expect(predictor.getStats().reconciliations).toBe(3);
  });

  it('refuses an exact duplicate', () => {
    const predictor = new Predictor(0);
    const initial = createInitialState();
    predictor.resync(snapshotFromState(initial, [-1, -1]));

    const snap = cloneState(initial);
    snap.tick = 42;
    predictor.reconcile(snapshotFromState(snap, [-1, -1]));
    predictor.reconcile(snapshotFromState(snap, [-1, -1]));

    expect(predictor.getStats().staleSnapshotsIgnored).toBe(1);
  });
});

describe('resync', () => {
  it('adopts authoritative state and discards pending inputs', () => {
    const predictor = new Predictor(0);
    const initial = createInitialState();

    for (let i = 0; i < 40; i++) predictor.predict({ seq: i, targetX: 400, targetY: 200 });
    expect(predictor.getStats().unackedInputs).toBe(40);

    const authoritative = createInitialState();
    authoritative.tick = 5000;
    predictor.resync(snapshotFromState(authoritative, [-1, -1]));

    expect(predictor.getStats().unackedInputs).toBe(0);
    expect(predictor.getState().tick).toBe(5000);
    // No residual visual offset either; a resync is a hard cut, not a correction.
    const rendered = predictor.getRenderedSelf();
    expect(rendered.x).toBeCloseTo(authoritative.paddles[0]!.x, 9);
  });
});
