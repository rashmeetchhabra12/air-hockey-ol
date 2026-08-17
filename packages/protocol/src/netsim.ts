import type { Transport, WireData } from './transport.js';

/**
 * Impairments applied to a link.
 *
 * Read through a callback on every packet rather than captured once, so the
 * demo's sliders take effect immediately on an already-open connection.
 */
export interface NetworkConditions {
  /** Round-trip time in milliseconds. Half is applied in each direction. */
  rttMs: number;
  /** Uniform jitter, +/- this many milliseconds, applied per packet per direction. */
  jitterMs: number;
  /** Probability in [0, 1] that a packet is dropped. */
  lossRate: number;
  /** Probability in [0, 1] that a packet is delivered twice. */
  duplicateRate: number;
}

export const PERFECT_NETWORK: NetworkConditions = {
  rttMs: 0,
  jitterMs: 0,
  lossRate: 0,
  duplicateRate: 0,
};

/** Deferred delivery, so the harness can substitute a virtual clock for `setTimeout`. */
export type Scheduler = (fn: () => void, delayMs: number) => void;

const defaultScheduler: Scheduler = (fn, delayMs) => {
  setTimeout(fn, delayMs);
};

/**
 * Wrap a transport in a simulated network.
 *
 * This is the mechanism behind the demo's latency slider and, later, the
 * harness's measurements. Both directions are impaired independently, because
 * an input lost on the way up and a snapshot lost on the way down produce very
 * different artefacts — and telling those apart is most of what debugging
 * netcode consists of.
 *
 * Jitter is applied per packet, so packets can and do arrive **out of order**.
 * That is the point: reordering is the condition that separates netcode which
 * merely works on a good connection from netcode which is actually correct.
 */
export function withSimulatedNetwork(
  inner: Transport,
  conditions: () => NetworkConditions,
  options: { schedule?: Scheduler; random?: () => number } = {},
): Transport {
  const schedule = options.schedule ?? defaultScheduler;
  const random = options.random ?? Math.random;

  function delayFor(c: NetworkConditions): number {
    const oneWay = c.rttMs / 2;
    const jitter = c.jitterMs > 0 ? (random() * 2 - 1) * c.jitterMs : 0;
    // Negative delay would deliver a packet before it was sent.
    return Math.max(0, oneWay + jitter);
  }

  function impair(deliver: (data: WireData) => void, data: WireData): void {
    const c = conditions();

    if (c.lossRate > 0 && random() < c.lossRate) return;

    const delay = delayFor(c);
    if (delay === 0) {
      deliver(data);
    } else {
      schedule(() => deliver(data), delay);
    }

    if (c.duplicateRate > 0 && random() < c.duplicateRate) {
      // A duplicate takes its own independent path, so it may arrive before the
      // original. Receivers must be idempotent, not merely tolerant.
      schedule(() => deliver(data), delayFor(c));
    }
  }

  const outer: Transport = {
    send(data) {
      impair((d) => inner.send(d), data);
    },
    close() {
      inner.close();
    },
    onMessage: null,
    onClose: null,
  };

  inner.onMessage = (data) => {
    impair((d) => outer.onMessage?.(d), data);
  };

  // Connection teardown is not impaired: delaying a close would leave the room
  // holding a slot for a peer that is provably gone.
  inner.onClose = () => outer.onClose?.();

  return outer;
}
