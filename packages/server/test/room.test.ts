import {
  createLoopbackPair,
  jsonCodec,
  type ServerMessage,
  type Transport,
  type WireInput,
} from '@ah/protocol';
import { PLAYER_COUNT, RINK_HEIGHT, RINK_WIDTH, TICK_RATE } from '@ah/sim';
import { describe, expect, it } from 'vitest';

import { GameRoom } from '../src/room.js';

/** A peer that records everything the room sends it. */
class TestClient {
  readonly received: ServerMessage[] = [];
  readonly raw: string[] = [];

  constructor(readonly transport: Transport) {
    transport.onMessage = (data) => {
      if (typeof data === 'string') this.raw.push(data);
      const msg = jsonCodec.decodeServer(data);
      if (msg) this.received.push(msg);
    };
  }

  /**
   * `seq` is the tick the client simulated this input at, so it must name a
   * tick the server has not yet reached. An input stamped for an already-
   * simulated tick is a straggler, and is handled by rewind rather than by the
   * ordinary path.
   */
  sendInputs(inputs: WireInput[]): void {
    this.transport.send(jsonCodec.encodeClient({ t: 'in', inputs }));
  }

  /** Bypasses the codec so malformed traffic can be tested. */
  sendRaw(data: string): void {
    this.transport.send(data);
  }

  of<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === type);
  }
}

function connect(room: GameRoom): { client: TestClient; slot: number | null } {
  const [serverEnd, clientEnd] = createLoopbackPair();
  const client = new TestClient(clientEnd);
  const slot = room.join(serverEnd);
  return { client, slot };
}

describe('GameRoom', () => {
  it('welcomes peers into sequential slots', () => {
    const room = new GameRoom();

    const a = connect(room);
    const b = connect(room);

    expect(a.slot).toBe(0);
    expect(b.slot).toBe(1);

    const welcomeA = a.client.of('welcome')[0]!;
    expect(welcomeA.slot).toBe(0);
    expect(welcomeA.tickRate).toBe(TICK_RATE);
    expect(b.client.of('welcome')[0]!.slot).toBe(1);
  });

  it('turns away a third peer instead of seating it', () => {
    const room = new GameRoom();
    connect(room);
    connect(room);

    const third = connect(room);
    expect(third.slot).toBeNull();
    expect(third.client.of('full')).toHaveLength(1);
    expect(room.occupancy).toBe(PLAYER_COUNT);
  });

  it('frees a slot on disconnect and reuses it', () => {
    const room = new GameRoom();
    const a = connect(room);
    connect(room);

    expect(room.occupancy).toBe(2);
    a.client.transport.close();
    expect(room.occupancy).toBe(1);

    const replacement = connect(room);
    expect(replacement.slot).toBe(0);
  });

  it('broadcasts snapshots at the configured interval', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 3 });
    const a = connect(room);

    for (let i = 0; i < 30; i++) room.tick();

    // 30 ticks at one snapshot every 3 ticks.
    expect(a.client.of('snap')).toHaveLength(10);
  });

  it('applies client input to that client s paddle only', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);
    connect(room);

    const startX = room.getState().paddles[0]!.x;
    const startOpponentX = room.getState().paddles[1]!.x;

    a.client.sendInputs([{ seq: 1, x: startX + 200, y: RINK_HEIGHT / 2 }]);
    for (let i = 0; i < 30; i++) room.tick();

    expect(room.getState().paddles[0]!.x).toBeGreaterThan(startX);
    expect(room.getState().paddles[1]!.x).toBe(startOpponentX);
  });

  /**
   * The ack tells a client which of its inputs are now settled history and can
   * stop being replayed. Since inputs are applied at the tick they are stamped
   * for, that is simply the newest tick the server has simulated — whether or
   * not an input happened to exist for it.
   */
  it('acks the newest simulated tick', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);
    connect(room);

    a.client.sendInputs([
      { seq: 1, x: 100, y: 100 },
      { seq: 2, x: 110, y: 100 },
      { seq: 3, x: 120, y: 100 },
    ]);

    for (let i = 0; i < 5; i++) room.tick();

    const snaps = a.client.of('snap');
    const latest = snaps[snaps.length - 1]!;
    expect(latest.acks[0]).toBe(5);
    // An idle slot is acked identically: the server simulated those ticks for
    // it too, holding its paddle's last target.
    expect(latest.acks[1]).toBe(5);
  });

  it('reports how many inputs are queued ahead of the simulation', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);
    connect(room);

    a.client.sendInputs([
      { seq: 6, x: 100, y: 100 },
      { seq: 7, x: 110, y: 100 },
    ]);
    for (let i = 0; i < 3; i++) room.tick();

    const snaps = a.client.of('snap');
    const latest = snaps[snaps.length - 1]!;
    // Both still ahead of tick 3, so the client knows it has margin.
    expect(latest.depth[0]).toBe(2);
    expect(latest.depth[1]).toBe(0);
  });

  it('carries paddle seek targets so a client can reconstruct server state', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);

    a.client.sendInputs([{ seq: 1, x: 300, y: 250 }]);
    room.tick();

    const snap = a.client.of('snap')[0]!;
    expect(snap.tgts).toHaveLength(PLAYER_COUNT);
    expect(snap.tgts[0]).toEqual([300, 250]);
  });

  it('sends identical snapshot bytes to every peer', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);
    const b = connect(room);

    a.client.raw.length = 0;
    b.client.raw.length = 0;
    room.tick();

    // One encode, broadcast to all — this is what makes acks slot-indexed
    // rather than tailored per recipient.
    expect(a.client.raw).toEqual(b.client.raw);
  });

  it('rejects malformed payloads without disturbing the tick loop', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);

    a.client.sendRaw('not json at all');
    a.client.sendRaw('{"t":"in"}');
    a.client.sendRaw('{"t":"unknown"}');

    expect(() => room.tick()).not.toThrow();
    expect(room.getClientStats()[0]!.rejected).toBe(3);
  });

  /**
   * `clamp` returns NaN for a NaN input, so a non-finite target would propagate
   * into the puck solver and desync every peer. JSON cannot even represent NaN,
   * so the attack arrives as `null` or a string and must be refused at decode.
   */
  it('refuses non-finite paddle targets', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);

    a.client.sendRaw('{"t":"in","inputs":[{"seq":0,"x":null,"y":0}]}');
    a.client.sendRaw('{"t":"in","inputs":[{"seq":1,"x":"NaN","y":0}]}');
    a.client.sendRaw('{"t":"in","inputs":[{"seq":2,"x":1e400,"y":0}]}');

    for (let i = 0; i < 10; i++) room.tick();

    const state = room.getState();
    expect(Number.isFinite(state.paddles[0]!.x)).toBe(true);
    expect(Number.isFinite(state.puck.x)).toBe(true);
    expect(room.getClientStats()[0]!.rejected).toBe(3);
  });

  it('refuses oversized input batches', () => {
    const room = new GameRoom();
    const a = connect(room);

    const huge = Array.from({ length: 5000 }, (_, i) => ({ seq: i, x: 0, y: 0 }));
    a.client.sendInputs(huge);

    expect(room.getClientStats()[0]!.rejected).toBe(1);
  });

  it('answers pings with the current server tick', () => {
    const room = new GameRoom();
    const a = connect(room);

    for (let i = 0; i < 7; i++) room.tick();
    a.client.transport.send(jsonCodec.encodeClient({ t: 'ping', id: 42, sent: 1234 }));

    const pong = a.client.of('pong')[0]!;
    expect(pong.id).toBe(42);
    expect(pong.sent).toBe(1234);
    expect(pong.serverTick).toBe(7);
  });

  it('clamps a hostile out-of-bounds target into the player s own half', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);

    // Slot 0 attempting to reach deep into the opponent's half.
    a.client.sendInputs([{ seq: 1, x: RINK_WIDTH * 10, y: RINK_HEIGHT * 10 }]);
    for (let i = 0; i < 120; i++) room.tick();

    expect(room.getState().paddles[0]!.x).toBeLessThan(RINK_WIDTH / 2);
  });

  it('tracks bandwidth per client', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 3 });
    const a = connect(room);

    a.client.sendInputs([{ seq: 1, x: 100, y: 100 }]);
    for (let i = 0; i < 60; i++) room.tick();

    const stats = room.getClientStats()[0]!;
    expect(stats.bytesSent).toBeGreaterThan(0);
    expect(stats.bytesReceived).toBeGreaterThan(0);
    expect(stats.messagesSent).toBe(1 + 20); // welcome + one second of snapshots
  });

  it('stops the departed player s paddle where it stands', () => {
    const room = new GameRoom({ snapshotIntervalTicks: 1 });
    const a = connect(room);

    a.client.sendInputs([{ seq: 1, x: 400, y: 500 }]);
    for (let i = 0; i < 10; i++) room.tick();

    const before = { ...room.getState().paddles[0]! };
    a.client.transport.close();
    for (let i = 0; i < 30; i++) room.tick();

    const after = room.getState().paddles[0]!;
    // Snapping an abandoned paddle home could teleport it through the puck.
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(after.vx).toBe(0);
  });
});
