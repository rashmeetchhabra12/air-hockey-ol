import {
  jsonCodec,
  snapshotFromState,
  wireSize,
  type Codec,
  type ServerMessage,
  type Transport,
} from '@ah/protocol';
import {
  createInitialState,
  step,
  FACEOFF_FREEZE_TICKS,
  PLAYER_COUNT,
  TICK_RATE,
  type GameState,
  type InputSet,
  type PlayerInput,
  type SimEvent,
} from '@ah/sim';

import { TickHistory, type HistoryEntry } from './history.js';
import { InputBuffer } from './input-buffer.js';

/** Ticks between snapshot broadcasts. 3 at 60 Hz gives the planned 20 Hz snapshot rate. */
export const DEFAULT_SNAPSHOT_INTERVAL = 3;

/**
 * How far back a late input may still be honoured, in ticks.
 *
 * 15 ticks is 250 ms — comfortably more than a bad connection's one-way delay,
 * and short enough that the past being rewritten is still recognisably the
 * present for the other player. Unbounded rewind would let a client claim an
 * arbitrarily stale moment, which is both a fairness problem and an attack.
 */
export const DEFAULT_REWIND_WINDOW = 15;

/** History depth. Slightly more than the rewind window, so replay always has a base state. */
const HISTORY_CAPACITY = DEFAULT_REWIND_WINDOW + 5;

export interface RoomOptions {
  codec?: Codec;
  snapshotIntervalTicks?: number;
  /** Ticks of rewind allowed for late inputs. Zero disables lag compensation. */
  rewindWindowTicks?: number;
  /** Begin with the face-off countdown. Defaults to true. */
  startFrozen?: boolean;
}

export interface ClientStats {
  slot: number;
  bytesSent: number;
  bytesReceived: number;
  messagesSent: number;
  messagesReceived: number;
  /** Malformed payloads rejected by the codec. Non-zero means a broken or hostile peer. */
  rejected: number;
  /** Inputs that arrived after their tick had been simulated. */
  lateInputs: number;
  /** Late inputs recovered by rewinding. */
  compensated: number;
  /** Late inputs beyond the rewind window, discarded. */
  tooLate: number;
}

export interface RoomStats {
  /** Rewinds performed. */
  rewinds: number;
  /** Total ticks re-simulated. Divided by `rewinds`, the average rewind depth. */
  resimulatedTicks: number;
}

interface Session {
  slot: number;
  transport: Transport;
  stats: ClientStats;
}

/**
 * The authoritative game room.
 *
 * Owns the only copy of truth. Knows nothing about WebSockets, Durable Objects,
 * timers, or wall-clock time: it is driven purely by `tick()` being called, and
 * talks to peers only through the `Transport` interface. That is what lets the
 * headless harness drive this exact class — not a reimplementation of it —
 * across a simulated network.
 */
export class GameRoom {
  private state: GameState = createInitialState();
  private readonly sessions: Array<Session | null> = new Array(PLAYER_COUNT).fill(null);
  private readonly buffers: InputBuffer[] = [];
  private readonly codec: Codec;
  private readonly snapshotInterval: number;
  private readonly rewindWindow: number;
  private readonly history = new TickHistory(HISTORY_CAPACITY);

  /** Reused per tick to avoid allocating an input array 60 times a second. */
  private readonly inputScratch: Array<PlayerInput | null> = new Array(PLAYER_COUNT).fill(null);

  /** Events from the most recent tick. Presentation only; never fed back in. */
  readonly events: SimEvent[] = [];

  readonly stats: RoomStats = { rewinds: 0, resimulatedTicks: 0 };

  constructor(options: RoomOptions = {}) {
    this.codec = options.codec ?? jsonCodec;
    this.snapshotInterval = options.snapshotIntervalTicks ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.rewindWindow = options.rewindWindowTicks ?? DEFAULT_REWIND_WINDOW;
    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      this.buffers.push(new InputBuffer());
    }

    // Open with the same countdown a goal produces, so a match never simply
    // starts mid-play on someone who has just arrived. Opt-out because most
    // tests want to observe the puck immediately.
    if (options.startFrozen !== false) {
      this.state.freezeTicks = FACEOFF_FREEZE_TICKS;
    }
  }

  getState(): GameState {
    return this.state;
  }

  get occupancy(): number {
    return this.sessions.reduce((n, s) => n + (s === null ? 0 : 1), 0);
  }

  get isEmpty(): boolean {
    return this.occupancy === 0;
  }

  getClientStats(): ClientStats[] {
    return this.sessions.filter((s): s is Session => s !== null).map((s) => ({ ...s.stats }));
  }

  /**
   * Seat a new peer.
   *
   * @returns the assigned slot, or `null` if the room is full — in which case
   *          the caller is told so and the transport is closed.
   */
  join(transport: Transport): number | null {
    const slot = this.sessions.indexOf(null);
    if (slot === -1) {
      this.sendTo(transport, { t: 'full' }, null);
      transport.close();
      return null;
    }

    const session: Session = {
      slot,
      transport,
      stats: {
        slot,
        bytesSent: 0,
        bytesReceived: 0,
        messagesSent: 0,
        messagesReceived: 0,
        rejected: 0,
        lateInputs: 0,
        compensated: 0,
        tooLate: 0,
      },
    };

    this.sessions[slot] = session;
    this.buffers[slot]!.reset();

    // A peer arriving mid-stream has no baseline to apply deltas against, so
    // the next broadcast must be self-contained. Harmless for codecs that do
    // not delta-encode.
    const forceKeyframe = (this.codec as { forceKeyframe?: () => void }).forceKeyframe;
    if (typeof forceKeyframe === 'function') forceKeyframe.call(this.codec);

    transport.onMessage = (data) => this.handleMessage(session, data);
    transport.onClose = () => this.leave(slot);

    this.sendTo(
      transport,
      { t: 'welcome', slot, tick: this.state.tick, tickRate: TICK_RATE },
      session,
    );

    return slot;
  }

  leave(slot: number): void {
    const session = this.sessions[slot];
    if (!session) return;

    this.sessions[slot] = null;
    this.buffers[slot]!.reset();
    session.transport.onMessage = null;
    session.transport.onClose = null;

    // Park the vacated paddle where it stands rather than snapping it home, so
    // a disconnect mid-rally does not teleport a body through the puck.
    const paddle = this.state.paddles[slot];
    if (paddle) {
      paddle.targetX = paddle.x;
      paddle.targetY = paddle.y;
      paddle.vx = 0;
      paddle.vy = 0;
    }
  }

  private handleMessage(
    session: Session,
    data: Parameters<NonNullable<Transport['onMessage']>>[0],
  ): void {
    session.stats.messagesReceived++;
    session.stats.bytesReceived += wireSize(data);

    const msg = this.codec.decodeClient(data);
    if (msg === null) {
      // Malformed, oversized, or non-finite. Counted rather than thrown: a
      // hostile peer must not be able to interrupt the tick loop.
      session.stats.rejected++;
      return;
    }

    if (msg.t === 'in') {
      const buffer = this.buffers[session.slot]!;
      let earliestLate = Number.POSITIVE_INFINITY;

      for (const wire of msg.inputs) {
        const input: PlayerInput = { seq: wire.seq, targetX: wire.x, targetY: wire.y };
        const result = buffer.push(input, this.state.tick, this.rewindWindow);

        if (result === 'late') {
          session.stats.lateInputs++;
          if (wire.seq < earliestLate) earliestLate = wire.seq;
          // Hold it so the rewind replay can find it.
          this.stashLate(session.slot, input);
        } else if (result === 'rejected') {
          session.stats.tooLate++;
        }
      }

      if (Number.isFinite(earliestLate) && this.rewindWindow > 0) {
        if (this.rewind(earliestLate)) session.stats.compensated++;
      }
      return;
    }

    if (msg.t === 'ping') {
      this.sendTo(
        session.transport,
        { t: 'pong', id: msg.id, sent: msg.sent, serverTick: this.state.tick },
        session,
      );
    }
  }

  /** Late inputs awaiting a rewind replay, keyed by tick then slot. */
  private readonly late = new Map<number, Array<PlayerInput | null>>();

  private stashLate(slot: number, input: PlayerInput): void {
    let row = this.late.get(input.seq);
    if (!row) {
      row = new Array<PlayerInput | null>(PLAYER_COUNT).fill(null);
      this.late.set(input.seq, row);
    }
    row[slot] = input;
  }

  /**
   * Restore the world to `fromTick`, fold in the late inputs, and replay forward.
   *
   * Bounded by construction: `canRewindTo` fails outside the retained window, so
   * a client cannot claim an arbitrarily stale moment however it stamps its
   * packets.
   */
  private rewind(fromTick: number): boolean {
    if (this.rewindWindow <= 0) return false;
    if (fromTick <= this.state.tick - this.rewindWindow) return false;
    if (!this.history.canRewindTo(fromTick)) return false;

    const base = this.history.get(fromTick - 1);
    if (!base) return false;

    const target = this.state.tick;
    let replayed: GameState = base.state;
    const rewritten: HistoryEntry[] = [];

    for (let tick = fromTick; tick <= target; tick++) {
      const recorded = this.history.get(tick);
      const inputs: Array<PlayerInput | null> = recorded
        ? recorded.inputs.slice()
        : new Array<PlayerInput | null>(PLAYER_COUNT).fill(null);

      // Fold in anything that arrived too late to be applied the first time.
      const stashed = this.late.get(tick);
      if (stashed) {
        for (let slot = 0; slot < PLAYER_COUNT; slot++) {
          if (stashed[slot]) inputs[slot] = stashed[slot]!;
        }
        this.late.delete(tick);
      }

      replayed = step(replayed, inputs as InputSet, null);
      rewritten.push({ state: replayed, inputs });
    }

    this.history.overwrite(fromTick, rewritten);
    this.state = replayed;

    this.stats.rewinds++;
    this.stats.resimulatedTicks += target - fromTick + 1;

    // Anything still stashed is older than the replay and can never be applied.
    for (const tick of this.late.keys()) {
      if (tick < fromTick) this.late.delete(tick);
    }

    return true;
  }

  /**
   * Advance the authoritative simulation one tick and broadcast on schedule.
   *
   * Called by whatever is driving time — the `FixedTimestepLoop` in production,
   * a virtual clock in the harness.
   */
  tick(): void {
    const nextTick = this.state.tick + 1;

    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      this.inputScratch[slot] = this.buffers[slot]!.take(nextTick);
    }

    this.events.length = 0;
    this.state = step(this.state, this.inputScratch as InputSet, this.events);
    this.history.record(this.state, this.inputScratch);

    // Stashed inputs older than the window will never be replayed.
    const horizon = this.state.tick - this.rewindWindow;
    for (const tick of this.late.keys()) {
      if (tick < horizon) this.late.delete(tick);
    }

    if (this.state.tick % this.snapshotInterval === 0) {
      this.broadcastSnapshot();
    }
  }

  /**
   * Send authoritative state to everyone.
   *
   * Encoded exactly once and reused for every recipient. Per-slot values ride as
   * arrays indexed by slot rather than being tailored per client, which is what
   * makes the single encoding possible — and outbound traffic is the bulk of the
   * bill.
   */
  private broadcastSnapshot(): void {
    const acks: number[] = [];
    const depth: number[] = [];
    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      acks.push(this.buffers[slot]!.ack);
      depth.push(this.buffers[slot]!.depthAbove(this.state.tick));
    }

    const snapshot = snapshotFromState(this.state, acks);
    snapshot.depth = depth;

    const payload = this.codec.encodeServer(snapshot);
    const size = wireSize(payload);

    for (const session of this.sessions) {
      if (!session) continue;
      try {
        session.transport.send(payload);
        session.stats.messagesSent++;
        session.stats.bytesSent += size;
      } catch {
        // A dead socket must not take the room down with it.
        this.leave(session.slot);
      }
    }
  }

  private sendTo(transport: Transport, msg: ServerMessage, session: Session | null): void {
    const payload = this.codec.encodeServer(msg);
    try {
      transport.send(payload);
      if (session) {
        session.stats.messagesSent++;
        session.stats.bytesSent += wireSize(payload);
      }
    } catch {
      if (session) this.leave(session.slot);
    }
  }
}
