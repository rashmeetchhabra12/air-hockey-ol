/** Anything a transport can carry. Binary arrives in P7; JSON strings until then. */
export type WireData = string | ArrayBuffer;

/**
 * The seam between netcode and the network.
 *
 * Every piece of networking in the project talks to this and nothing else. Three
 * implementations exist against it:
 *
 *   - `WebSocketTransport`   — the real one, browser and Durable Object
 *   - `SimulatedTransport`   — the harness, with injectable latency, jitter,
 *                              loss, reordering, and duplication
 *   - `LoopbackTransport`    — an in-process pair, for tests that need two ends
 *                              without a network at all
 *
 * Keeping the interface this narrow is what lets the harness measure the real
 * client and server code paths rather than a stripped-down imitation of them,
 * and what keeps a future WebTransport backend (P11) from touching netcode.
 */
export interface Transport {
  send(data: WireData): void;
  close(): void;
  /** Invoked for each inbound payload. Assigning replaces any previous handler. */
  onMessage: ((data: WireData) => void) | null;
  onClose: (() => void) | null;
}

/**
 * A pair of transports wired directly to each other, with no network in between.
 *
 * Delivery is synchronous and perfectly ordered, so any desync a test finds
 * using this is a simulation or protocol bug, never a networking artefact.
 */
export function createLoopbackPair(): [Transport, Transport] {
  const a: Transport = { send: () => {}, close: () => {}, onMessage: null, onClose: null };
  const b: Transport = { send: () => {}, close: () => {}, onMessage: null, onClose: null };

  let open = true;

  a.send = (data) => {
    if (open) b.onMessage?.(data);
  };
  b.send = (data) => {
    if (open) a.onMessage?.(data);
  };

  const closeBoth = (): void => {
    if (!open) return;
    open = false;
    a.onClose?.();
    b.onClose?.();
  };

  a.close = closeBoth;
  b.close = closeBoth;

  return [a, b];
}
