import {
  decodeLobbyServer,
  encodeLobbyClient,
  type LobbyServerMessage,
} from '@ah/protocol';

/**
 * Client half of matchmaking.
 *
 * Keeps a socket open to the lobby while the player waits. The wait itself is
 * not shown as a wait: the caller drops them into a bot match immediately and
 * swaps them across when `onMatched` fires, so nobody watches a spinner.
 */

export type LobbyState = 'idle' | 'connecting' | 'searching' | 'matched' | 'error';

export interface LobbyOptions {
  url: string;
  name: string;
  onState?: (state: LobbyState, detail?: string) => void;
  onMatched?: (room: string, opponent: string) => void;
}

export class LobbyClient {
  state: LobbyState = 'idle';
  /** How many players are queued ahead of this one. */
  ahead = 0;

  private socket: WebSocket | null = null;
  /** Set once matched, so a late close event is not reported as a failure. */
  private done = false;

  constructor(private readonly options: LobbyOptions) {}

  search(): void {
    this.done = false;
    this.setState('connecting');

    const url = `${this.options.url}/lobby?name=${encodeURIComponent(this.options.name)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.setState('searching');
      socket.send(encodeLobbyClient({ t: 'find' }));
    });

    socket.addEventListener('message', (event) => {
      const msg = decodeLobbyServer(event.data);
      if (msg) this.handle(msg);
    });

    socket.addEventListener('error', () => {
      if (!this.done) this.setState('error', 'could not reach matchmaking');
    });

    socket.addEventListener('close', () => {
      // A close after a successful match is the expected ending, not a fault.
      if (!this.done && this.state !== 'idle') {
        this.setState('error', 'matchmaking disconnected');
      }
    });
  }

  cancel(): void {
    this.done = true;
    try {
      this.socket?.send(encodeLobbyClient({ t: 'cancel' }));
    } catch {
      // Socket already gone; closing below is enough.
    }
    this.socket?.close();
    this.socket = null;
    this.setState('idle');
  }

  private handle(msg: LobbyServerMessage): void {
    if (msg.t === 'queued') {
      this.ahead = msg.ahead;
      this.setState('searching');
      return;
    }

    if (msg.t === 'matched') {
      this.done = true;
      this.setState('matched');
      // The lobby's work is finished the moment it names the room; the match
      // itself is a direct connection between the players and the room object.
      this.socket?.close();
      this.socket = null;
      this.options.onMatched?.(msg.room, msg.opponent);
      return;
    }

    if (msg.t === 'cancelled') this.setState('idle');
  }

  private setState(state: LobbyState, detail?: string): void {
    this.state = state;
    this.options.onState?.(state, detail);
  }
}
