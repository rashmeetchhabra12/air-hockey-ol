import {
  createBinaryCodec,
  jsonCodec,
  sanitizeName,
  webSocketTransport,
  type Codec,
  type WebSocketLike,
} from '@ah/protocol';
import { FixedTimestepLoop, GameRoom } from '@ah/server';
import { TICK_RATE } from '@ah/sim';

/**
 * Cloudflare adapter.
 *
 * Deliberately thin. All authority lives in `GameRoom` and all pacing in
 * `FixedTimestepLoop`, neither of which knows this file exists — which is what
 * makes the P0 fallback (move to a VPS) a change of adapter rather than a
 * rewrite, and what lets the headless harness drive the identical room class.
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
}

/**
 * Timer cadence. Finer than the 16.67 ms tick so the accumulator, not the
 * timer, sets the pace. See `FixedTimestepLoop` for why that distinction
 * matters on this runtime.
 */
const TIMER_MS = 8;

/** Ticks simulated in one callback before backlog is abandoned. */
const MAX_CATCHUP_TICKS = 5;

/**
 * Idle grace before an empty room stops ticking.
 *
 * Not zero, because a player who reloads the page reconnects within a second or
 * two and should find the match still in progress rather than reset.
 */
const IDLE_SHUTDOWN_MS = 10_000;

export { Lobby } from './lobby.js';

export class MatchRoom implements DurableObject {
  /**
   * Created on first connection rather than in the constructor, because the wire
   * format is chosen per room and the choice arrives with the first client. A
   * room cannot mix codecs: the binary one delta-encodes against a single shared
   * baseline, so every peer must be reading the same stream.
   */
  private room: GameRoom | null = null;
  private readonly loop: FixedTimestepLoop;
  private emptySince: number | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.loop = new FixedTimestepLoop({
      tickRate: TICK_RATE,
      timerMs: TIMER_MS,
      maxCatchupTicks: MAX_CATCHUP_TICKS,
      now: () => Date.now(),
      onTick: () => this.onTick(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    if (this.room === null) {
      const wantsJson = new URL(request.url).searchParams.get('codec') === 'json';
      const codec: Codec = wantsJson ? jsonCodec : createBinaryCodec();
      this.room = new GameRoom({ codec });
    }

    const pair = new WebSocketPair();
    const client = pair[0]!;
    const server = pair[1]!;

    server.accept();

    const name = sanitizeName(new URL(request.url).searchParams.get('name'));
    const transport = webSocketTransport(server as unknown as WebSocketLike);
    const slot = this.room.join(transport, name);

    if (slot === null) {
      // `join` already sent a `full` message and closed the transport.
      return new Response(null, { status: 101, webSocket: client });
    }

    this.emptySince = null;
    if (!this.loop.running) this.loop.start();

    return new Response(null, { status: 101, webSocket: client });
  }

  private onTick(): void {
    if (this.room === null) return;
    this.room.tick();

    if (this.room.isEmpty) {
      const now = Date.now();
      // Keep ticking briefly so a reconnecting player rejoins a live match
      // rather than a reset one.
      if (this.emptySince === null) {
        this.emptySince = now;
      } else if (now - this.emptySince >= IDLE_SHUTDOWN_MS) {
        this.loop.stop();
        this.emptySince = null;
      }
    } else {
      this.emptySince = null;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // Matchmaking. A single object holds the queue, which is what makes
    // "is anyone waiting? take them" safe without a lock: a Durable Object
    // handles one request at a time, so two simultaneous arrivals cannot
    // interleave.
    if (url.pathname === '/lobby') {
      return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(request);
    }

    if (url.pathname !== '/ws') {
      return new Response('connect a websocket to /ws?room=<name>', { status: 404 });
    }

    // Room name comes from the query string, so a shareable link is just a URL.
    // Normalised so that trivially different spellings do not silently split a
    // match into two rooms.
    const requested = (url.searchParams.get('room') ?? 'default').toLowerCase();
    const name = requested.replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'default';

    const id = env.ROOM.idFromName(name);
    return env.ROOM.get(id).fetch(request);
  },
};
