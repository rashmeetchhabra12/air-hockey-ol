import type { Transport, WireData } from './transport.js';

/**
 * Minimal WebSocket-like surface.
 *
 * Declared structurally rather than importing `lib.dom` or Cloudflare's types,
 * so this file compiles unchanged in the browser, in a Durable Object, and in
 * Node. The three runtimes' WebSocket implementations differ in their type
 * declarations but agree on exactly this much.
 */
export interface WebSocketLike {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  /**
   * Declared as a method (not a property) so TypeScript compares the listener
   * bivariantly. The three runtimes each type the event differently — DOM's
   * `MessageEvent`, workerd's own — and no single parameter type is assignable
   * to all of them under strict contravariance. The event is narrowed at the
   * point of use instead.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: string, listener: (event: any) => void): void;
}

/**
 * Adapt a WebSocket to the `Transport` interface.
 *
 * `error` is folded into `onClose` deliberately: from the netcode's point of
 * view a socket that errored and a socket that closed are the same event — the
 * peer is gone — and giving them separate paths only invites one of them to be
 * handled and the other forgotten.
 */
export function webSocketTransport(socket: WebSocketLike): Transport {
  let closed = false;

  const transport: Transport = {
    send(data: WireData) {
      if (closed) return;
      socket.send(data);
    },
    close() {
      if (closed) return;
      closed = true;
      socket.close();
    },
    onMessage: null,
    onClose: null,
  };

  socket.addEventListener('message', (event: unknown) => {
    const data = (event as { data?: unknown }).data;
    // Anything that is neither text nor binary is not ours; ignore rather than
    // throw, so a stray frame cannot take the connection down.
    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      transport.onMessage?.(data);
    }
  });

  const handleGone = (): void => {
    if (closed) return;
    closed = true;
    transport.onClose?.();
  };

  socket.addEventListener('close', handleGone);
  socket.addEventListener('error', handleGone);

  return transport;
}
