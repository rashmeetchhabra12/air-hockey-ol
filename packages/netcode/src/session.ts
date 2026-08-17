import {
  jsonCodec,
  wireSize,
  type Codec,
  type Transport,
  type WireInput,
  type WireSnapshot,
} from '@ah/protocol';
import { TICK_RATE } from '@ah/sim';

/**
 * A client's protocol-level conversation with the server.
 *
 * Transport-agnostic on purpose: it talks to a `Transport` and reads time from
 * an injected clock, so the same class runs behind a browser WebSocket and
 * inside the headless harness on virtual time. Anything measured about it is
 * therefore measured about the code that actually ships.
 */

/** Sampled every tick, transmitted every other one. Halves packet count. */
const DEFAULT_SEND_EVERY = 2;

/**
 * Inputs repeated in each packet.
 *
 * Three covers the loss of one packet entirely, since consecutive packets
 * overlap. Cheap insurance — an input is three small numbers — and it is a
 * UDP-era technique that still pays on TCP, because retransmitting a *stale*
 * input is worthless: by the time it arrives the server has moved on.
 */
const DEFAULT_REDUNDANCY = 3;

export interface SessionOptions {
  codec?: Codec;
  redundancy?: number;
  sendEveryNSamples?: number;
  /** Injected so the harness can run on virtual time. */
  now?: () => number;
  onWelcome?: (slot: number, tickRate: number) => void;
  onSnapshot?: (snapshot: WireSnapshot) => void;
  onFull?: () => void;
  onClose?: () => void;
}

export class ClientSession {
  slot: number | null = null;
  serverTickRate = TICK_RATE;
  /** Smoothed round-trip time in milliseconds. */
  rttMs = 0;

  bytesSent = 0;
  bytesReceived = 0;
  snapshotsReceived = 0;
  /** Payloads the codec refused. Non-zero means a broken or hostile server. */
  rejected = 0;

  private readonly codec: Codec;
  private readonly redundancy: number;
  private readonly sendEvery: number;
  private readonly now: () => number;

  private samplesSinceSend = 0;
  private readonly recent: WireInput[] = [];

  private pingId = 0;
  private readonly pendingPings = new Map<number, number>();

  constructor(
    private readonly transport: Transport,
    private readonly options: SessionOptions = {},
  ) {
    this.codec = options.codec ?? jsonCodec;
    this.redundancy = options.redundancy ?? DEFAULT_REDUNDANCY;
    this.sendEvery = options.sendEveryNSamples ?? DEFAULT_SEND_EVERY;
    this.now = options.now ?? (() => Date.now());

    transport.onMessage = (data) => this.handle(data);
    transport.onClose = () => this.options.onClose?.();
  }

  get ready(): boolean {
    return this.slot !== null;
  }

  /**
   * Queue one tick of intent, transmitting on schedule.
   *
   * Called once per client tick by the simulation loop — never from a render
   * callback, which runs at the display's refresh rate and would make the input
   * rate a property of the player's monitor.
   */
  queueInput(input: WireInput): void {
    this.recent.push(input);
    while (this.recent.length > this.redundancy) this.recent.shift();

    this.samplesSinceSend++;
    if (this.samplesSinceSend < this.sendEvery) return;
    this.samplesSinceSend = 0;

    const payload = this.codec.encodeClient({ t: 'in', inputs: this.recent.slice() });
    this.bytesSent += wireSize(payload);
    this.transport.send(payload);
  }

  sendPing(): void {
    const id = this.pingId++;
    this.pendingPings.set(id, this.now());
    const payload = this.codec.encodeClient({ t: 'ping', id, sent: id });
    this.bytesSent += wireSize(payload);
    this.transport.send(payload);
  }

  close(): void {
    this.transport.close();
  }

  private handle(data: string | ArrayBuffer): void {
    this.bytesReceived += wireSize(data);

    const msg = this.codec.decodeServer(data);
    if (!msg) {
      this.rejected++;
      return;
    }

    switch (msg.t) {
      case 'welcome':
        this.slot = msg.slot;
        this.serverTickRate = msg.tickRate;
        this.options.onWelcome?.(msg.slot, msg.tickRate);
        break;

      case 'snap':
        this.snapshotsReceived++;
        this.options.onSnapshot?.(msg);
        break;

      case 'pong': {
        const sentAt = this.pendingPings.get(msg.id);
        this.pendingPings.delete(msg.id);
        if (sentAt !== undefined) {
          const sample = this.now() - sentAt;
          // Exponential smoothing: one delayed packet should nudge the reading,
          // not redefine it.
          this.rttMs = this.rttMs === 0 ? sample : this.rttMs * 0.8 + sample * 0.2;
        }
        break;
      }

      case 'full':
        this.options.onFull?.();
        break;
    }
  }
}
