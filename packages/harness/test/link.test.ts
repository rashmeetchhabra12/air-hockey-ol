import { PERFECT_NETWORK, type NetworkConditions } from '@ah/protocol';
import { describe, expect, it } from 'vitest';

import { VirtualLink, type LinkMode } from '../src/link.js';
import { mulberry32 } from '../src/rng.js';

function conditions(overrides: Partial<NetworkConditions> = {}): NetworkConditions {
  return { ...PERFECT_NETWORK, ...overrides };
}

/** A link driven by a manual clock, with everything the client received recorded. */
function harness(mode: LinkMode, c: NetworkConditions, seed = 1) {
  let now = 0;
  const link = new VirtualLink(c, mode, mulberry32(seed), () => now);
  const received: string[] = [];
  link.clientSide.onMessage = (d) => received.push(d as string);

  return {
    link,
    received,
    /** Advance in 1 ms steps, delivering as the runner does. */
    advance(ms: number) {
      for (let i = 0; i < ms; i++) {
        now += 1;
        link.deliverDue();
      }
    },
    sendToClient(text: string) {
      link.serverSide.send(text);
    },
    get now() {
      return now;
    },
  };
}

describe('VirtualLink — datagram semantics', () => {
  it('delivers after half the round trip', () => {
    const h = harness('unreliable', conditions({ rttMs: 100 }));
    h.sendToClient('a');

    h.advance(49);
    expect(h.received).toEqual([]);
    h.advance(2);
    expect(h.received).toEqual(['a']);
  });

  it('drops packets at roughly the configured rate', () => {
    const h = harness('unreliable', conditions({ rttMs: 20, lossRate: 0.3 }));
    for (let i = 0; i < 2000; i++) h.sendToClient(`p${i}`);
    h.advance(200);

    const delivered = h.received.length;
    // Statistical, so a band rather than an exact figure.
    expect(delivered).toBeGreaterThan(1200);
    expect(delivered).toBeLessThan(1600);
    expect(h.link.stats.dropped).toBe(2000 - delivered);
  });

  /**
   * Jitter is applied per packet, so packets can overtake one another. This is
   * the condition that separates netcode which works on a good connection from
   * netcode which is actually correct.
   */
  it('reorders packets under jitter', () => {
    const h = harness('unreliable', conditions({ rttMs: 100, jitterMs: 40 }), 7);
    for (let i = 0; i < 200; i++) {
      h.sendToClient(`${i}`);
      h.advance(2);
    }
    h.advance(400);

    const order = h.received.map(Number);
    const outOfOrder = order.some((v, i) => i > 0 && v < order[i - 1]!);
    expect(outOfOrder).toBe(true);
  });

  it('never retransmits', () => {
    const h = harness('unreliable', conditions({ rttMs: 20, lossRate: 0.5 }));
    for (let i = 0; i < 100; i++) h.sendToClient(`p${i}`);
    h.advance(200);
    expect(h.link.stats.retransmits).toBe(0);
  });
});

describe('VirtualLink — TCP-like semantics', () => {
  it('never drops a packet', () => {
    const h = harness('reliable-ordered', conditions({ rttMs: 40, lossRate: 0.3 }));
    for (let i = 0; i < 500; i++) h.sendToClient(`p${i}`);
    h.advance(5000);

    expect(h.link.stats.dropped).toBe(0);
    expect(h.received).toHaveLength(500);
  });

  it('preserves order even under heavy jitter', () => {
    const h = harness('reliable-ordered', conditions({ rttMs: 100, jitterMs: 45 }), 11);
    for (let i = 0; i < 300; i++) {
      h.sendToClient(`${i}`);
      h.advance(2);
    }
    h.advance(2000);

    const order = h.received.map(Number);
    expect(order).toEqual(order.slice().sort((a, b) => a - b));
  });

  /**
   * The point of modelling TCP at all.
   *
   * A lost packet is retransmitted, and everything behind it waits — so one
   * loss delays a whole run of otherwise-healthy packets. That is the cost of
   * shipping on WebSocket, and being able to state it with a number is worth
   * more than an opinion about it.
   */
  it('holds later packets behind a lost one', () => {
    // Deterministic single loss: the first packet is lost, the rest are not.
    let calls = 0;
    let now = 0;
    const link = new VirtualLink(
      conditions({ rttMs: 40, lossRate: 0.5 }),
      'reliable-ordered',
      () => (calls++ === 0 ? 0.0 : 0.99), // first roll loses, all later rolls pass
      () => now,
    );

    const arrivals: Array<{ text: string; at: number }> = [];
    link.clientSide.onMessage = (d) => arrivals.push({ text: d as string, at: now });

    link.serverSide.send('first');
    link.serverSide.send('second');
    link.serverSide.send('third');

    for (let i = 0; i < 500; i++) {
      now += 1;
      link.deliverDue();
    }

    expect(link.stats.retransmits).toBe(1);
    expect(arrivals.map((a) => a.text)).toEqual(['first', 'second', 'third']);

    // Without head-of-line blocking, 'second' would have arrived at ~20 ms. It
    // instead waits for the retransmitted 'first'.
    expect(arrivals[1]!.at).toBe(arrivals[0]!.at);
    expect(arrivals[1]!.at).toBeGreaterThan(100);
  });

  /**
   * How much head-of-line blocking costs depends on how densely packets are
   * spaced relative to the retransmission timeout.
   *
   * At this project's snapshot rate — one packet every 50 ms against a 120 ms
   * timeout — only two or three packets queue behind a loss, so the median is
   * barely touched and the damage lands in the tail. Send every 5 ms instead
   * and roughly two dozen packets pile up behind each loss, which drags the
   * *median* out too.
   *
   * The 50 ms spacing here is deliberate: it is what the game actually does, so
   * this test verifies the claim the README makes rather than a worse one that
   * would not apply.
   */
  it('pushes the latency tail out without moving the median, at realistic packet spacing', () => {
    const clean = harness('reliable-ordered', conditions({ rttMs: 100 }), 3);
    const lossy = harness('reliable-ordered', conditions({ rttMs: 100, lossRate: 0.05 }), 3);

    for (const h of [clean, lossy]) {
      for (let i = 0; i < 300; i++) {
        h.sendToClient(`${i}`);
        h.advance(50); // the 20 Hz snapshot cadence
      }
      h.advance(2000);
    }

    const cleanP50 = clean.link.stats.latencyToClient.percentile(0.5);
    const lossyP50 = lossy.link.stats.latencyToClient.percentile(0.5);
    const cleanP99 = clean.link.stats.latencyToClient.percentile(0.99);
    const lossyP99 = lossy.link.stats.latencyToClient.percentile(0.99);

    expect(lossyP50).toBeLessThan(cleanP50 + 10);
    expect(lossyP99).toBeGreaterThan(cleanP99 * 1.5);
  });
});

describe('VirtualLink — accounting', () => {
  it('counts bytes in both directions', () => {
    const h = harness('unreliable', conditions());
    h.sendToClient('hello');
    h.link.clientSide.send('hi');
    h.advance(10);

    expect(h.link.stats.bytesToClient).toBe(5);
    expect(h.link.stats.bytesToServer).toBe(2);
  });

  it('stops delivering once closed', () => {
    const h = harness('unreliable', conditions({ rttMs: 100 }));
    h.sendToClient('a');
    h.link.close();
    h.advance(200);
    expect(h.received).toEqual([]);
  });
});
