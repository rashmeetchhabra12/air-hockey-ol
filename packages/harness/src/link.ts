import { wireSize, type NetworkConditions, type Transport, type WireData } from '@ah/protocol';

import { Samples } from './metrics.js';

/**
 * Delivery semantics.
 *
 * - `unreliable` — datagram behaviour. Packets are dropped independently and
 *   jitter reorders them. This is what WebRTC DataChannel or WebTransport
 *   datagrams would give us.
 *
 * - `reliable-ordered` — a model of TCP, which is what WebSocket actually runs
 *   on. Nothing is ever lost; a "lost" packet is retransmitted after a timeout,
 *   and — critically — every packet behind it waits. That is **head-of-line
 *   blocking**, and it is the cost of the transport choice.
 *
 * Modelling both is the point. The project ships on WebSocket, and being able
 * to say what that costs, with a number, is worth more than an opinion about
 * it. See the caveat on `RETRANSMIT_TIMEOUT_MS` about what this model is not.
 */
export type LinkMode = 'unreliable' | 'reliable-ordered';

/**
 * Retransmission timeout for the reliable model.
 *
 * A deliberate simplification. Real TCP derives its RTO from measured RTT with
 * exponential backoff, and recovers faster than this via fast retransmit when
 * duplicate ACKs arrive. A flat timeout captures the *shape* of head-of-line
 * blocking — one loss stalls everything behind it — without pretending to be a
 * congestion-control implementation. Numbers from this model should be read as
 * "this is the kind of cost TCP imposes", not as a prediction of a specific
 * kernel's behaviour.
 */
const RETRANSMIT_TIMEOUT_MS = 120;

/** Guards against an unbounded retransmit loop at pathological loss rates. */
const MAX_RETRANSMITS = 12;

interface Packet {
  /** Virtual time at which this packet reaches the far end. */
  arriveAt: number;
  /** Per-direction ordering number, used by the reliable model. */
  seq: number;
  data: WireData;
  toClient: boolean;
  sentAt: number;
}

export interface LinkStats {
  bytesToServer: number;
  bytesToClient: number;
  packetsToServer: number;
  packetsToClient: number;
  /** Packets discarded outright. Always 0 in `reliable-ordered`. */
  dropped: number;
  /** Retransmission events. Always 0 in `unreliable`. */
  retransmits: number;
  /**
   * Observed one-way delivery latency per packet.
   *
   * Under `reliable-ordered` this includes time spent held at the receiver
   * waiting for an earlier packet — which is exactly the head-of-line cost the
   * measurement exists to expose.
   */
  latencyToClient: Samples;
  latencyToServer: Samples;
}

/**
 * A bidirectional link between one client and the server, on virtual time.
 *
 * Nothing here uses a real timer. `deliverDue` is called by the scenario runner
 * as it advances the clock, which makes an entire minute of gameplay measurable
 * in milliseconds and — more importantly — makes every run reproducible from
 * its seed.
 */
export class VirtualLink {
  /** Hand this to `GameRoom.join`. */
  readonly serverSide: Transport;
  /** Hand this to the simulated client. */
  readonly clientSide: Transport;

  readonly stats: LinkStats = {
    bytesToServer: 0,
    bytesToClient: 0,
    packetsToServer: 0,
    packetsToClient: 0,
    dropped: 0,
    retransmits: 0,
    latencyToClient: new Samples(),
    latencyToServer: new Samples(),
  };

  /** Sorted ascending by `arriveAt`. */
  private queue: Packet[] = [];

  private nextSeq = { toClient: 0, toServer: 0 };
  private nextExpected = { toClient: 0, toServer: 0 };
  private held = { toClient: new Map<number, Packet>(), toServer: new Map<number, Packet>() };

  private closed = false;

  constructor(
    private readonly conditions: NetworkConditions,
    private readonly mode: LinkMode,
    private readonly random: () => number,
    private readonly now: () => number,
  ) {
    this.serverSide = {
      send: (data) => this.enqueue(data, true),
      close: () => this.close(),
      onMessage: null,
      onClose: null,
    };
    this.clientSide = {
      send: (data) => this.enqueue(data, false),
      close: () => this.close(),
      onMessage: null,
      onClose: null,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.serverSide.onClose?.();
    this.clientSide.onClose?.();
  }

  private oneWayDelay(): number {
    const base = this.conditions.rttMs / 2;
    const jitter =
      this.conditions.jitterMs > 0 ? (this.random() * 2 - 1) * this.conditions.jitterMs : 0;
    return Math.max(0, base + jitter);
  }

  private enqueue(data: WireData, toClient: boolean): void {
    if (this.closed) return;

    const bytes = wireSize(data);
    const sentAt = this.now();

    if (toClient) {
      this.stats.bytesToClient += bytes;
      this.stats.packetsToClient++;
    } else {
      this.stats.bytesToServer += bytes;
      this.stats.packetsToServer++;
    }

    if (this.mode === 'unreliable') {
      if (this.conditions.lossRate > 0 && this.random() < this.conditions.lossRate) {
        this.stats.dropped++;
        return;
      }
      this.push({
        arriveAt: sentAt + this.oneWayDelay(),
        seq: toClient ? this.nextSeq.toClient++ : this.nextSeq.toServer++,
        data,
        toClient,
        sentAt,
      });

      if (this.conditions.duplicateRate > 0 && this.random() < this.conditions.duplicateRate) {
        // The duplicate takes its own path and may overtake the original, so
        // receivers must be idempotent rather than merely tolerant.
        this.push({
          arriveAt: sentAt + this.oneWayDelay(),
          seq: toClient ? this.nextSeq.toClient++ : this.nextSeq.toServer++,
          data,
          toClient,
          sentAt,
        });
      }
      return;
    }

    // reliable-ordered: loss becomes delay, never disappearance.
    let departAt = sentAt;
    let attempts = 0;
    while (
      this.conditions.lossRate > 0 &&
      attempts < MAX_RETRANSMITS &&
      this.random() < this.conditions.lossRate
    ) {
      departAt += RETRANSMIT_TIMEOUT_MS;
      attempts++;
      this.stats.retransmits++;
    }

    this.push({
      arriveAt: departAt + this.oneWayDelay(),
      seq: toClient ? this.nextSeq.toClient++ : this.nextSeq.toServer++,
      data,
      toClient,
      sentAt,
    });
  }

  /** Binary-search insert keeps the queue ordered without re-sorting each send. */
  private push(packet: Packet): void {
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.queue[mid]!.arriveAt <= packet.arriveAt) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, packet);
  }

  /** Deliver everything whose arrival time has passed. Called once per virtual millisecond. */
  deliverDue(): void {
    if (this.closed) return;
    const now = this.now();

    while (this.queue.length > 0 && this.queue[0]!.arriveAt <= now) {
      const packet = this.queue.shift()!;
      if (this.mode === 'unreliable') {
        this.deliver(packet, now);
      } else {
        this.deliverOrdered(packet, now);
      }
    }
  }

  /**
   * Reliable path: a packet may only be handed up once every earlier one has
   * been. Anything that arrives early waits, which is head-of-line blocking.
   */
  private deliverOrdered(packet: Packet, now: number): void {
    const key = packet.toClient ? 'toClient' : 'toServer';
    const held = this.held[key];

    held.set(packet.seq, packet);

    for (;;) {
      const next = held.get(this.nextExpected[key]);
      if (!next) break;
      held.delete(this.nextExpected[key]);
      this.nextExpected[key]++;
      this.deliver(next, now);
    }
  }

  private deliver(packet: Packet, now: number): void {
    const latency = now - packet.sentAt;
    if (packet.toClient) {
      this.stats.latencyToClient.add(latency);
      this.clientSide.onMessage?.(packet.data);
    } else {
      this.stats.latencyToServer.add(latency);
      this.serverSide.onMessage?.(packet.data);
    }
  }
}
