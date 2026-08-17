import { createInitialState, hashState, RINK_HEIGHT, RINK_WIDTH, step } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { createBinaryCodec } from '../src/binary.js';
import { jsonCodec, wireSize } from '../src/codec.js';
import type { WireSnapshot } from '../src/messages.js';
import { snapshotFromState, stateFromSnapshot } from '../src/snapshot.js';
import {
  dequantizePosition,
  POSITION_STEP,
  quantizePosition,
  quantizeTarget,
  quantizeVelocity,
  VELOCITY_STEP,
} from '../src/quantize.js';

function snapshotOf(state = createInitialState(), acks = [0, 0]): WireSnapshot {
  return snapshotFromState(state, acks);
}

/** A snapshot stream from real gameplay, for realistic delta measurements. */
function gameplayStream(count: number): WireSnapshot[] {
  let state = createInitialState();
  state.puck.vx = 520;
  state.puck.vy = -330;

  const out: WireSnapshot[] = [];
  for (let i = 0; i < count * 3; i++) {
    state = step(state, [
      { seq: i, targetX: 260 + Math.sin(i / 9) * 170, targetY: 300 + Math.cos(i / 6) * 210 },
      { seq: i, targetX: 740 - Math.sin(i / 7) * 160, targetY: 300 - Math.cos(i / 8) * 200 },
    ]);
    if (i % 3 === 0) out.push(snapshotOf(state, [i, i]));
  }
  return out;
}

describe('quantisation', () => {
  it('round-trips positions within one step', () => {
    for (const v of [0, 1, 250.5, RINK_WIDTH, RINK_HEIGHT, -40, RINK_WIDTH + 40]) {
      const back = dequantizePosition(quantizePosition(v));
      expect(Math.abs(back - v)).toBeLessThanOrEqual(POSITION_STEP);
    }
  });

  /**
   * The puck legitimately leaves the playing surface — it crosses the goal line
   * to score, and contact resolution nudges it a hair past a wall. A range that
   * stopped at the rink edge would wrap those to the far side.
   */
  it('represents positions outside the rink', () => {
    expect(dequantizePosition(quantizePosition(-30))).toBeLessThan(0);
    expect(dequantizePosition(quantizePosition(RINK_WIDTH + 30))).toBeGreaterThan(RINK_WIDTH);
  });

  it('clamps rather than wrapping when far out of range', () => {
    // Wrapping would put a wild value in the middle of the rink, which is much
    // worse than pinning it to an edge.
    const low = dequantizePosition(quantizePosition(-1e6));
    const high = dequantizePosition(quantizePosition(1e6));
    expect(low).toBeLessThan(0);
    expect(high).toBeGreaterThan(RINK_WIDTH);
    expect(Number.isFinite(low)).toBe(true);
    expect(Number.isFinite(high)).toBe(true);
  });

  it('keeps the position step below the correction dead zone', () => {
    // 0.05 units is where the client starts treating a disagreement as real.
    // Rounding finer than that keeps quantisation invisible.
    expect(POSITION_STEP).toBeLessThan(0.05);
  });

  it('round-trips velocities within one step', () => {
    for (const v of [0, 1, -1, 900, -1800, 1800]) {
      const q = quantizeVelocity(v);
      const back = (q / 32767) * 2048;
      expect(Math.abs(back - v)).toBeLessThanOrEqual(VELOCITY_STEP);
    }
  });

  it('is idempotent, so a target survives repeated rounding', () => {
    const once = quantizeTarget(333.333, 222.222);
    const twice = quantizeTarget(once.x, once.y);
    expect(twice).toEqual(once);
  });
});

describe('binary codec round-trips', () => {
  it('preserves a welcome', () => {
    const codec = createBinaryCodec();
    const msg = { t: 'welcome' as const, slot: 1, tick: 4242, tickRate: 60 };
    expect(codec.decodeServer(codec.encodeServer(msg))).toEqual(msg);
  });

  it('preserves a pong at full precision', () => {
    const codec = createBinaryCodec();
    // Timing feeds the RTT estimate, not the simulation, so it is not quantised.
    const msg = { t: 'pong' as const, id: 9, sent: 1699999999999.5, serverTick: 77 };
    expect(codec.decodeServer(codec.encodeServer(msg))).toEqual(msg);
  });

  it('preserves an input batch within quantisation error', () => {
    const codec = createBinaryCodec();
    const msg = {
      t: 'in' as const,
      inputs: [
        { seq: 900, x: 123.45, y: 321.54 },
        { seq: 901, x: 130.0, y: 315.0 },
        { seq: 902, x: 140.25, y: 300.75 },
      ],
    };

    const decoded = codec.decodeClient(codec.encodeClient(msg));
    expect(decoded?.t).toBe('in');
    const inputs = (decoded as { inputs: typeof msg.inputs }).inputs;
    expect(inputs).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(inputs[i]!.seq).toBe(msg.inputs[i]!.seq);
      expect(Math.abs(inputs[i]!.x - msg.inputs[i]!.x)).toBeLessThanOrEqual(POSITION_STEP);
      expect(Math.abs(inputs[i]!.y - msg.inputs[i]!.y)).toBeLessThanOrEqual(POSITION_STEP);
    }
  });

  it('preserves every snapshot field across a keyframe', () => {
    const encoder = createBinaryCodec();
    const decoder = createBinaryCodec();

    let state = createInitialState();
    for (let i = 0; i < 50; i++) {
      state = step(state, [
        { seq: i, targetX: 300 + i, targetY: 200 + i },
        { seq: i, targetX: 700 - i, targetY: 400 - i },
      ]);
    }
    state.score[0] = 3;
    state.score[1] = 2;
    state.freezeTicks = 7;

    const original = snapshotOf(state, [49, 49]);
    original.depth = [4, 1];

    const decoded = decoder.decodeServer(encoder.encodeServer(original)) as WireSnapshot;

    expect(decoded.tick).toBe(original.tick);
    expect(decoded.score).toEqual(original.score);
    expect(decoded.frz).toBe(original.frz);
    expect(decoded.touch).toBe(original.touch);
    expect(decoded.touchTick).toBe(original.touchTick);
    expect(decoded.own).toBe(original.own);
    expect(decoded.ownEp).toBe(original.ownEp);
    expect(decoded.acks).toEqual(original.acks);
    expect(decoded.depth).toEqual(original.depth);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(decoded.puck[i]! - original.puck[i]!)).toBeLessThanOrEqual(VELOCITY_STEP);
    }
  });
});

describe('delta encoding', () => {
  it('reconstructs a whole stream through deltas', () => {
    const encoder = createBinaryCodec();
    const decoder = createBinaryCodec();
    const stream = gameplayStream(80);

    for (const snap of stream) {
      const decoded = decoder.decodeServer(encoder.encodeServer(snap)) as WireSnapshot;
      expect(decoded).not.toBeNull();
      expect(decoded.tick).toBe(snap.tick);
      expect(decoded.score).toEqual(snap.score);
      expect(Math.abs(decoded.puck[0]! - snap.puck[0]!)).toBeLessThanOrEqual(POSITION_STEP);
      expect(Math.abs(decoded.puck[1]! - snap.puck[1]!)).toBeLessThanOrEqual(POSITION_STEP);
    }
  });

  it('emits a keyframe first, then smaller deltas', () => {
    const encoder = createBinaryCodec();
    const stream = gameplayStream(30);

    const sizes = stream.map((s) => wireSize(encoder.encodeServer(s)));
    const keyframe = sizes[0]!;
    const deltas = sizes.slice(1, 19); // before the next periodic keyframe

    expect(Math.max(...deltas)).toBeLessThan(keyframe);
  });

  /**
   * Deltas are relative to the previous snapshot sent, so a peer arriving
   * mid-stream has no baseline. It must wait for a keyframe rather than decode
   * nonsense.
   */
  it('refuses a delta when it has no baseline', () => {
    const encoder = createBinaryCodec();
    const stream = gameplayStream(5);

    encoder.encodeServer(stream[0]!); // keyframe, sent to nobody
    const delta = encoder.encodeServer(stream[1]!);

    const latecomer = createBinaryCodec();
    expect(latecomer.decodeServer(delta)).toBeNull();
  });

  it('recovers once a keyframe is forced', () => {
    const encoder = createBinaryCodec();
    const stream = gameplayStream(5);
    encoder.encodeServer(stream[0]!);
    encoder.encodeServer(stream[1]!);

    const latecomer = createBinaryCodec();
    expect(latecomer.decodeServer(encoder.encodeServer(stream[2]!))).toBeNull();

    encoder.forceKeyframe();
    const recovered = latecomer.decodeServer(encoder.encodeServer(stream[3]!)) as WireSnapshot;
    expect(recovered).not.toBeNull();
    expect(recovered.tick).toBe(stream[3]!.tick);
  });

  it('re-keys periodically without being asked', () => {
    const encoder = createBinaryCodec();
    const stream = gameplayStream(60);
    stream.forEach((s) => encoder.encodeServer(s));

    // A peer joining late still recovers within about a second.
    const latecomer = createBinaryCodec();
    let recoveredAt = -1;
    const more = gameplayStream(60);
    for (let i = 0; i < more.length; i++) {
      if (latecomer.decodeServer(encoder.encodeServer(more[i]!)) !== null) {
        recoveredAt = i;
        break;
      }
    }
    expect(recoveredAt).toBeGreaterThanOrEqual(0);
    expect(recoveredAt).toBeLessThan(20);
  });
});

describe('binary codec rejects hostile input', () => {
  it('refuses text while the codec is binary', () => {
    const codec = createBinaryCodec();
    expect(codec.decodeClient('{"t":"in"}')).toBeNull();
    expect(codec.decodeServer('{"t":"snap"}')).toBeNull();
  });

  it('refuses a truncated frame', () => {
    const codec = createBinaryCodec();
    const full = codec.encodeClient({ t: 'in', inputs: [{ seq: 1, x: 10, y: 10 }] }) as ArrayBuffer;
    expect(codec.decodeClient(full.slice(0, 3))).toBeNull();
  });

  it('refuses an empty or oversized batch claim', () => {
    const codec = createBinaryCodec();
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint8(0, 5); // MSG_INPUT
    view.setUint8(1, 0); // count 0
    expect(codec.decodeClient(buf)).toBeNull();

    view.setUint8(1, 200); // absurd count
    expect(codec.decodeClient(buf)).toBeNull();
  });

  it('refuses an unknown message type', () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint8(0, 250);
    expect(createBinaryCodec().decodeClient(buf)).toBeNull();
    expect(createBinaryCodec().decodeServer(buf)).toBeNull();
  });

  it('refuses trailing bytes after a complete batch', () => {
    const codec = createBinaryCodec();
    const good = codec.encodeClient({ t: 'in', inputs: [{ seq: 1, x: 10, y: 10 }] }) as ArrayBuffer;
    const padded = new Uint8Array(good.byteLength + 4);
    padded.set(new Uint8Array(good));
    expect(codec.decodeClient(padded.buffer)).toBeNull();
  });
});

describe('bandwidth', () => {
  /**
   * The headline comparison. Measured over a real gameplay stream rather than a
   * synthetic one, because delta encoding's payoff depends entirely on how much
   * actually changes between ticks.
   */
  it('is dramatically smaller than JSON over a gameplay stream', () => {
    const encoder = createBinaryCodec();
    const stream = gameplayStream(200);

    let json = 0;
    let binary = 0;
    for (const snap of stream) {
      json += wireSize(jsonCodec.encodeServer(snap));
      binary += wireSize(encoder.encodeServer(snap));
    }

    expect(binary).toBeLessThan(json * 0.35);
  });
});

describe('what quantisation costs', () => {
  /**
   * The property that is deliberately given up.
   *
   * JSON carries full `float64`, so a client adopting a snapshot resumes from
   * the server's exact numbers and replay is bit-identical. Quantised binary
   * rounds them, so it cannot be. Stating that here rather than discovering it
   * as a mysterious drift later.
   */
  it('costs bit-exact state reconstruction, which JSON preserves', () => {
    let state = createInitialState();
    state.puck.vx = 411.7;
    state.puck.vy = -298.3;
    for (let i = 0; i < 30; i++) state = step(state, [null, null]);

    const snap = snapshotOf(state, [29, 29]);

    const viaJson = stateFromSnapshot(
      jsonCodec.decodeServer(jsonCodec.encodeServer(snap)) as WireSnapshot,
    );
    expect(hashState(viaJson)).toBe(hashState(state));

    const encoder = createBinaryCodec();
    const decoder = createBinaryCodec();
    const viaBinary = stateFromSnapshot(
      decoder.decodeServer(encoder.encodeServer(snap)) as WireSnapshot,
    );
    expect(hashState(viaBinary)).not.toBe(hashState(state));

    // But the error is far below anything a player could perceive, and below
    // the client's correction dead zone.
    expect(Math.abs(viaBinary.puck.x - state.puck.x)).toBeLessThan(POSITION_STEP);
    expect(Math.abs(viaBinary.puck.y - state.puck.y)).toBeLessThan(POSITION_STEP);
  });
});
