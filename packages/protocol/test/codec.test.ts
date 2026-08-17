import { createInitialState, hashState, step, type InputSet } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { jsonCodec, wireSize } from '../src/codec.js';
import { snapshotFromState, stateFromSnapshot } from '../src/snapshot.js';
import { createLoopbackPair } from '../src/transport.js';

describe('jsonCodec round-trips', () => {
  it('preserves an input batch', () => {
    const msg = { t: 'in' as const, inputs: [{ seq: 3, x: 12.5, y: -4.25 }] };
    expect(jsonCodec.decodeClient(jsonCodec.encodeClient(msg))).toEqual(msg);
  });

  it('preserves a ping', () => {
    const msg = { t: 'ping' as const, id: 9, sent: 1699999999999 };
    expect(jsonCodec.decodeClient(jsonCodec.encodeClient(msg))).toEqual(msg);
  });

  it('preserves a welcome', () => {
    const msg = { t: 'welcome' as const, slot: 1, tick: 42, tickRate: 60 };
    expect(jsonCodec.decodeServer(jsonCodec.encodeServer(msg))).toEqual(msg);
  });

  it('preserves a snapshot', () => {
    const snap = snapshotFromState(createInitialState(), [4, -1]);
    expect(jsonCodec.decodeServer(jsonCodec.encodeServer(snap))).toEqual(snap);
  });
});

describe('jsonCodec rejects hostile input', () => {
  const badClient = [
    ['not json', 'garbage'],
    ['wrong type', '{"t":"nope"}'],
    ['missing inputs', '{"t":"in"}'],
    ['empty batch', '{"t":"in","inputs":[]}'],
    ['null coordinate', '{"t":"in","inputs":[{"seq":0,"x":null,"y":0}]}'],
    ['string coordinate', '{"t":"in","inputs":[{"seq":0,"x":"1","y":0}]}'],
    ['overflow to Infinity', '{"t":"in","inputs":[{"seq":0,"x":1e400,"y":0}]}'],
    ['absurd coordinate', '{"t":"in","inputs":[{"seq":0,"x":1e9,"y":0}]}'],
    ['negative seq', '{"t":"in","inputs":[{"seq":-1,"x":0,"y":0}]}'],
    ['fractional seq', '{"t":"in","inputs":[{"seq":1.5,"x":0,"y":0}]}'],
    ['array instead of object', '[]'],
    ['bare null', 'null'],
  ] as const;

  it.each(badClient)('refuses %s', (_label, payload) => {
    expect(jsonCodec.decodeClient(payload)).toBeNull();
  });

  it('refuses an oversized input batch', () => {
    const inputs = Array.from({ length: 100 }, (_, i) => ({ seq: i, x: 0, y: 0 }));
    expect(jsonCodec.decodeClient(JSON.stringify({ t: 'in', inputs }))).toBeNull();
  });

  it('refuses a snapshot whose targets do not match its paddles', () => {
    const snap = snapshotFromState(createInitialState(), [0, 0]);
    const broken = { ...snap, tgts: [[0, 0]] };
    expect(jsonCodec.decodeServer(JSON.stringify(broken))).toBeNull();
  });

  it('refuses binary payloads while the codec is JSON', () => {
    expect(jsonCodec.decodeClient(new ArrayBuffer(8))).toBeNull();
  });
});

describe('snapshot fidelity', () => {
  /**
   * The general guard against a field being left off the wire.
   *
   * `hashState` defines what "the same simulation state" means. If a snapshot
   * cannot reproduce a state's hash, then a reconciled client is provably out of
   * step with the server that sent it — no matter how correct the simulation
   * itself is. Checking the hash rather than named fields means a field added
   * later is covered automatically instead of being silently forgotten.
   */
  it('reproduces the exact state hash across the wire', () => {
    // Deliberately drive every hashed field away from its default.
    let state = createInitialState();
    state.puck.vx = 471.5;
    state.puck.vy = -318.25;
    for (let i = 0; i < 90; i++) {
      state = step(state, [
        { seq: i, targetX: 300 + i, targetY: 200 + i * 2 },
        { seq: i, targetX: 700 - i, targetY: 400 - i },
      ]);
    }
    state.score[0] = 3;
    state.score[1] = 2;
    state.freezeTicks = 7;

    const revived = stateFromSnapshot(
      jsonCodec.decodeServer(jsonCodec.encodeServer(snapshotFromState(state, [89, 89]))) as never,
    );

    expect(hashState(revived)).toBe(hashState(state));
  });

  it('carries the tick of the last puck strike', () => {
    let state = createInitialState();
    state.puck.vx = -900;
    // Drive the puck into the left paddle so a strike is recorded.
    for (let i = 0; i < 40; i++) state = step(state, [null, null]);

    expect(state.lastTouchTick).toBeGreaterThan(0);
    const revived = stateFromSnapshot(snapshotFromState(state, [0, 0]));
    expect(revived.lastTouchTick).toBe(state.lastTouchTick);
  });

  /**
   * The property reconciliation depends on: a snapshot must be a complete,
   * resumable simulation state. If anything that influences future ticks is
   * missing from the wire, a client adopting the snapshot and stepping forward
   * diverges from the server that sent it.
   */
  it('round-trips into a state that simulates identically to the original', () => {
    let server = createInitialState();
    server.puck.vx = 380;
    server.puck.vy = -260;

    const script: InputSet[] = [];
    for (let i = 0; i < 200; i++) {
      script.push([
        { seq: i, targetX: 200 + (i % 60) * 3, targetY: 150 + (i % 40) * 6 },
        { seq: i, targetX: 800 - (i % 50) * 4, targetY: 400 - (i % 30) * 5 },
      ]);
    }

    // Advance far enough that paddles hold non-trivial targets and velocities.
    for (let i = 0; i < 100; i++) server = step(server, script[i]!);

    const revived = stateFromSnapshot(
      jsonCodec.decodeServer(jsonCodec.encodeServer(snapshotFromState(server, [99, 99]))) as never,
    );

    // Both sides now step the remaining script independently.
    let a = server;
    let b = revived;
    for (let i = 100; i < 200; i++) {
      a = step(a, script[i]!);
      b = step(b, script[i]!);
    }

    expect(hashState(b)).toBe(hashState(a));
  });

  /**
   * Guards the specific field that is easy to leave off the wire because it
   * looks derivable. A paddle keeps seeking its stored target on ticks with no
   * input, so dropping it would leave the opponent's paddle stationary during
   * replay while the server kept moving it — straight into the puck.
   */
  it('diverges if paddle seek targets are dropped from the wire', () => {
    let server = createInitialState();
    server.puck.vx = 300;

    // Snapshot must be taken while the paddles are still *travelling*. Once a
    // paddle reaches its target the two variants coincide by construction —
    // target and position become the same point — and the test proves nothing.
    for (let i = 0; i < 5; i++) {
      server = step(server, [
        { seq: i, targetX: 460, targetY: 120 },
        { seq: i, targetX: 540, targetY: 480 },
      ]);
    }
    expect(server.paddles[0]!.x).not.toBeCloseTo(server.paddles[0]!.targetX, 3);

    const snap = snapshotFromState(server, [39, 39]);
    const faithful = stateFromSnapshot(snap);
    // Simulate the omission: targets fall back to current positions.
    const lossy = stateFromSnapshot({
      ...snap,
      tgts: snap.pads.map((p) => [p[0], p[1]] as [number, number]),
    });

    let a = faithful;
    let b = lossy;
    for (let i = 0; i < 60; i++) {
      a = step(a, [null, null]);
      b = step(b, [null, null]);
    }

    expect(hashState(b)).not.toBe(hashState(a));
  });
});

describe('loopback transport', () => {
  it('delivers messages between both ends', () => {
    const [a, b] = createLoopbackPair();
    const seen: string[] = [];
    b.onMessage = (d) => seen.push(d as string);

    a.send('hello');
    expect(seen).toEqual(['hello']);
  });

  it('notifies both ends on close and then stops delivering', () => {
    const [a, b] = createLoopbackPair();
    let closedA = false;
    let closedB = false;
    a.onClose = () => {
      closedA = true;
    };
    b.onClose = () => {
      closedB = true;
    };

    const seen: string[] = [];
    b.onMessage = (d) => seen.push(d as string);

    a.close();
    expect(closedA).toBe(true);
    expect(closedB).toBe(true);

    a.send('after close');
    expect(seen).toEqual([]);
  });
});

describe('wireSize', () => {
  it('measures strings and buffers', () => {
    expect(wireSize('abcd')).toBe(4);
    expect(wireSize(new ArrayBuffer(16))).toBe(16);
  });
});
