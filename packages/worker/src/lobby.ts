import {
  decodeLobbyClient,
  encodeLobbyServer,
  sanitizeName,
  type LobbyServerMessage,
} from '@ah/protocol';

/**
 * Matchmaking.
 *
 * ## Why a queue rather than counting players
 *
 * The obvious model — count who is online, pair them up if the number is even —
 * falls apart on the cases that actually happen: someone leaves mid-count, two
 * people arrive in the same instant, a player is paired with someone who has
 * already closed the tab.
 *
 * A queue sidesteps all of it. Ask for a match, and either someone is waiting
 * (pair immediately) or nobody is (wait). Parity never needs computing: an odd
 * number of players means exactly one person is queued, by definition.
 *
 * A Durable Object is a particularly good fit because it is **single-threaded**.
 * Two players arriving at the same millisecond are processed one after the
 * other, so the "check the queue, then take from it" sequence cannot interleave.
 * The race that would need a lock elsewhere cannot occur here.
 *
 * ## Why it only hands out a name
 *
 * The lobby never touches the match. It tells both players which room to join
 * and steps out.
 *
 * That matters for latency: a Durable Object is created wherever it is first
 * accessed, so a lobby that opened the room itself would pin every match to the
 * lobby's region. Letting the players connect directly means the room is created
 * near whoever gets there first, which is at least one of the two participants
 * rather than neither.
 */

interface Waiting {
  socket: WebSocket;
  name: string;
  /** When they joined the queue, for stale-entry cleanup. */
  since: number;
}

/**
 * How long a queued player may sit before being dropped.
 *
 * A socket that has gone away without a close event would otherwise be handed
 * to the next arrival, who would then wait in an empty room wondering why their
 * opponent never appeared.
 */
const MAX_WAIT_MS = 5 * 60 * 1000;

function roomName(): string {
  // Short, unguessable enough that nobody stumbles into someone else's match.
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = 'm';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export class Lobby implements DurableObject {
  private queue: Waiting[] = [];

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const name = sanitizeName(url.searchParams.get('name'));

    const pair = new WebSocketPair();
    const client = pair[0]!;
    const server = pair[1]!;
    server.accept();

    const entry: Waiting = { socket: server, name, since: Date.now() };

    server.addEventListener('message', (event: MessageEvent) => {
      const msg = decodeLobbyClient(event.data);
      if (!msg) return;
      if (msg.t === 'find') this.find(entry);
      else if (msg.t === 'cancel') this.remove(entry, { t: 'cancelled' });
    });

    const forget = (): void => {
      this.queue = this.queue.filter((w) => w !== entry);
    };
    server.addEventListener('close', forget);
    server.addEventListener('error', forget);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Pair this player with whoever is waiting, or queue them.
   *
   * Runs to completion before any other request is handled, which is what makes
   * "is anyone waiting? take them" safe without a lock.
   */
  private find(entry: Waiting): void {
    this.prune();

    // Already queued — asking twice should not create two entries.
    if (this.queue.includes(entry)) {
      this.send(entry.socket, { t: 'queued', ahead: this.queue.indexOf(entry) });
      return;
    }

    const opponent = this.queue.shift();

    if (!opponent) {
      this.queue.push(entry);
      this.send(entry.socket, { t: 'queued', ahead: 0 });
      return;
    }

    const room = roomName();
    this.send(opponent.socket, { t: 'matched', room, opponent: entry.name });
    this.send(entry.socket, { t: 'matched', room, opponent: opponent.name });
  }

  private remove(entry: Waiting, notice: LobbyServerMessage): void {
    this.queue = this.queue.filter((w) => w !== entry);
    this.send(entry.socket, notice);
  }

  /** Drop sockets that have gone quiet, so nobody is matched with a ghost. */
  private prune(): void {
    const cutoff = Date.now() - MAX_WAIT_MS;
    this.queue = this.queue.filter((w) => {
      if (w.since >= cutoff) return true;
      try {
        w.socket.close(1000, 'waited too long');
      } catch {
        // Already gone, which is the outcome we wanted anyway.
      }
      return false;
    });
  }

  private send(socket: WebSocket, msg: LobbyServerMessage): void {
    try {
      socket.send(encodeLobbyServer(msg));
    } catch {
      // A dead socket must not take the lobby down with it.
      this.queue = this.queue.filter((w) => w.socket !== socket);
    }
  }
}
