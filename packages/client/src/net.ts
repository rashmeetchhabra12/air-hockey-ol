import { ClientSession } from '@ah/netcode';
import {
  webSocketTransport,
  withSimulatedNetwork,
  type Codec,
  type NetworkConditions,
  type WireInput,
  type WireSnapshot,
} from '@ah/protocol';

/**
 * Browser connection wrapper.
 *
 * Deliberately thin. Everything protocol-shaped — input batching, redundancy,
 * RTT estimation, decoding — lives in `ClientSession` in the netcode package,
 * because none of it is browser-specific and all of it is worth measuring. This
 * file exists only to create a WebSocket, apply the demo's simulated
 * impairments, and hand the result over.
 */

const PING_INTERVAL_MS = 1000;

export type ConnectionState = 'connecting' | 'connected' | 'full' | 'closed';

export interface ClientOptions {
  url: string;
  /** Must match the room's. A room cannot mix wire formats. */
  codec?: Codec;
  /** Read per packet, so demo sliders take effect on a live connection. */
  conditions: () => NetworkConditions;
  onStateChange?: (state: ConnectionState) => void;
  onWelcome?: (slot: number) => void;
  onRoster?: (names: string[]) => void;
  onSnapshot?: (snapshot: WireSnapshot) => void;
}

export class GameClient {
  state: ConnectionState = 'connecting';

  private session: ClientSession | null = null;
  private socket: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: ClientOptions) {}

  get slot(): number | null {
    return this.session?.slot ?? null;
  }

  get rttMs(): number {
    return this.session?.rttMs ?? 0;
  }

  get snapshotsReceived(): number {
    return this.session?.snapshotsReceived ?? 0;
  }

  get bytesReceived(): number {
    return this.session?.bytesReceived ?? 0;
  }

  get bytesSent(): number {
    return this.session?.bytesSent ?? 0;
  }

  get ready(): boolean {
    return this.session?.ready ?? false;
  }

  connect(): void {
    this.setState('connecting');

    const socket = new WebSocket(this.options.url);
    // Browsers deliver binary frames as a Blob unless told otherwise, and the
    // transport adapter only forwards strings and ArrayBuffers — so without
    // this every snapshot would be silently dropped once the binary codec is
    // in use, and the game would simply never start.
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      const impaired = withSimulatedNetwork(webSocketTransport(socket), this.options.conditions);

      this.session = new ClientSession(impaired, {
        ...(this.options.codec ? { codec: this.options.codec } : {}),
        now: () => performance.now(),
        onWelcome: (slot) => this.options.onWelcome?.(slot),
        onRoster: (names) => this.options.onRoster?.(names),
        onSnapshot: (snapshot) => this.options.onSnapshot?.(snapshot),
        onFull: () => {
          this.setState('full');
          this.disconnect();
        },
        onClose: () => this.handleClose(),
      });

      this.setState('connected');
      this.pingTimer = setInterval(() => this.session?.sendPing(), PING_INTERVAL_MS);
    });

    socket.addEventListener('error', () => this.handleClose());
    socket.addEventListener('close', () => this.handleClose());
  }

  queueInput(input: WireInput): void {
    this.session?.queueInput(input);
  }

  disconnect(): void {
    this.stopPings();
    this.session?.close();
    this.socket?.close();
    this.session = null;
    this.socket = null;
  }

  private stopPings(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private handleClose(): void {
    if (this.state === 'full') return;
    this.stopPings();
    this.setState('closed');
  }
}
