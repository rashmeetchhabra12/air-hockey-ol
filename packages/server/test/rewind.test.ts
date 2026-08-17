import { createLoopbackPair, jsonCodec, type ServerMessage, type Transport } from '@ah/protocol';
import { PADDLE_RADIUS, PUCK_RADIUS, RINK_HEIGHT, SLOT_LEFT } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { GameRoom } from '../src/room.js';

/** A peer that records what the room sends and can send arbitrary input ticks. */
class TestClient {
  readonly received: ServerMessage[] = [];

  constructor(readonly transport: Transport) {
    transport.onMessage = (data) => {
      const msg = jsonCodec.decodeServer(data);
      if (msg) this.received.push(msg);
    };
  }

  /** `tick` is the tick this input claims to have been simulated at. */
  send(tick: number, x: number, y: number): void {
    this.transport.send(jsonCodec.encodeClient({ t: 'in', inputs: [{ seq: tick, x, y }] }));
  }

  snapshots() {
    return this.received.filter((m) => m.t === 'snap');
  }
}

function connect(room: GameRoom): TestClient {
  const [serverEnd, clientEnd] = createLoopbackPair();
  const client = new TestClient(clientEnd);
  room.join(serverEnd);
  return client;
}

function run(room: GameRoom, ticks: number): void {
  for (let i = 0; i < ticks; i++) room.tick();
}

/**
 * Lag compensation.
 *
 * A client applies its input at tick T and sees the result immediately. That
 * input reaches the server tens of milliseconds later, by which time the world
 * has moved on. Applying it there puts the paddle in the right place at the
 * wrong moment, and a strike that plainly connected on the player's screen
 * simply misses. Rewinding restores tick T, applies the input where it belongs,
 * and replays forward.
 */
describe('server rewind', () => {
  it('applies an input at the tick it was stamped for', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const client = connect(room);

    // Sent well ahead of time, for a tick the server has not reached.
    client.send(10, 420, 120);
    run(room, 9);

    // Not yet applied: the server has only simulated up to tick 9.
    const before = room.getState().paddles[SLOT_LEFT]!.targetX;
    expect(before).not.toBe(420);

    room.tick();
    expect(room.getState().paddles[SLOT_LEFT]!.targetX).toBe(420);
  });

  it('rewinds to honour an input that arrived late', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const client = connect(room);

    run(room, 20);
    const withoutInput = room.getState().paddles[SLOT_LEFT]!.x;

    // A straggler for tick 15, arriving while the server is at tick 20.
    client.send(15, 460, 100);

    expect(room.stats.rewinds).toBe(1);
    // Five ticks of movement that had been missed are now accounted for.
    expect(room.getState().paddles[SLOT_LEFT]!.x).not.toBe(withoutInput);
    expect(room.getState().tick).toBe(20);
  });

  it('produces the same state as if the input had never been late', () => {
    function build(late: boolean) {
      const room = new GameRoom({ snapshotIntervalTicks: 1 });
      const client = connect(room);

      if (late) {
        run(room, 20);
        client.send(15, 460, 100);
      } else {
        run(room, 14);
        client.send(15, 460, 100);
        run(room, 6);
      }
      return room.getState();
    }

    const compensated = build(true);
    const punctual = build(false);

    // The whole point: the outcome does not depend on when the packet arrived.
    expect(compensated.tick).toBe(punctual.tick);
    expect(compensated.paddles[SLOT_LEFT]!.x).toBeCloseTo(punctual.paddles[SLOT_LEFT]!.x, 9);
    expect(compensated.paddles[SLOT_LEFT]!.y).toBeCloseTo(punctual.paddles[SLOT_LEFT]!.y, 9);
    expect(compensated.puck.x).toBeCloseTo(punctual.puck.x, 9);
    expect(compensated.puck.y).toBeCloseTo(punctual.puck.y, 9);
  });

  /**
   * The reason a player cares. A strike aimed at what was on screen should
   * connect, even though the server had moved past that moment by the time the
   * input arrived.
   */
  it('lets a late strike still connect with the puck', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const client = connect(room);

    // Line the puck up just in front of the left paddle, drifting slowly.
    const state = room.getState();
    const paddle = state.paddles[SLOT_LEFT]!;
    state.puck.x = paddle.x + PADDLE_RADIUS + PUCK_RADIUS + 30;
    state.puck.y = paddle.y;
    state.puck.vx = -60;
    state.puck.vy = 0;

    run(room, 12);
    const driftingAway = room.getState().puck.vx;
    expect(driftingAway).toBeLessThan(0); // still coming toward the paddle

    // A late strike, stamped several ticks back, driving the paddle into it.
    client.send(8, 460, RINK_HEIGHT / 2);

    expect(room.stats.rewinds).toBe(1);
    // The paddle moved during the replayed ticks rather than only from now on.
    expect(room.getState().paddles[SLOT_LEFT]!.x).toBeGreaterThan(paddle.x);
  });

  it('refuses to rewind beyond the window', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1, rewindWindowTicks: 5 });
    const client = connect(room);

    run(room, 40);
    client.send(10, 460, 100); // far outside a 5-tick window

    expect(room.stats.rewinds).toBe(0);
    expect(room.getClientStats()[0]!.tooLate).toBe(1);
  });

  it('performs no rewind when lag compensation is disabled', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1, rewindWindowTicks: 0 });
    const client = connect(room);

    run(room, 20);
    client.send(15, 460, 100);

    expect(room.stats.rewinds).toBe(0);
    expect(room.getClientStats()[0]!.tooLate).toBe(1);
  });

  it('bounds how much work one late packet can cause', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1, rewindWindowTicks: 8 });
    const client = connect(room);

    run(room, 30);
    client.send(24, 460, 100);

    expect(room.stats.rewinds).toBe(1);
    // Never more than the window, however the packet is stamped.
    expect(room.stats.resimulatedTicks).toBeLessThanOrEqual(8);
  });

  it('keeps the tick counter intact across a rewind', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const client = connect(room);

    run(room, 25);
    client.send(20, 400, 200);
    expect(room.getState().tick).toBe(25);

    run(room, 5);
    expect(room.getState().tick).toBe(30);
  });

  it('reports buffer depth so the client can steer its lead', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const client = connect(room);

    run(room, 5);
    for (const tick of [8, 9, 10]) client.send(tick, 300, 300);
    room.tick(); // now at tick 6

    const snaps = client.snapshots();
    const latest = snaps[snaps.length - 1]!;
    expect(latest.depth[SLOT_LEFT]).toBe(3);
  });

  it('counts stragglers per client', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const client = connect(room);

    run(room, 20);
    client.send(18, 400, 100);
    client.send(17, 400, 100);

    const stats = room.getClientStats()[0]!;
    expect(stats.lateInputs).toBe(2);
    expect(stats.compensated).toBeGreaterThan(0);
  });
});
