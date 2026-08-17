import { Bot } from '@ah/bot';
import { ClientSession, Predictor, SnapshotBuffer, TickPacer } from '@ah/netcode';
import {
  createBinaryCodec,
  createLoopbackPair,
  quantizeTarget,
  withSimulatedNetwork,
  type NetworkConditions,
  type WireSnapshot,
} from '@ah/protocol';
import { GameRoom } from '@ah/server';
import { PLAYER_COUNT, RINK_HEIGHT, RINK_WIDTH } from '@ah/sim';

/**
 * A whole match running inside the page.
 *
 * ## Why this exists
 *
 * The single most common way a multiplayer portfolio project fails is that
 * someone opens the link alone, finds nobody to play, and closes it. A demo
 * that requires two humans to demonstrate anything demonstrates nothing.
 *
 * So the page hosts its own authoritative room and connects one or two bots to
 * it over a *simulated* network — the same `withSimulatedNetwork` wrapper the
 * online client uses, on real timers. Nothing is faked: it is the real
 * `GameRoom`, the real `ClientSession`, the real `Predictor`, and the real
 * codec, with latency and loss applied between them.
 *
 * The consequence worth noticing is that the netcode demo needs no server at
 * all. Latency slider, netcode toggle, puck strategies, debug overlay — all of
 * it works from static hosting, instantly, on a phone, with no second player.
 */

export type LocalMode = 'spectate' | 'bot';

export interface LocalMatchOptions {
  mode: LocalMode;
  /** Read per packet, so the demo's sliders take effect on a live match. */
  conditions: () => NetworkConditions;
  difficulty?: number;
  seed?: number;
}

interface LocalPlayer {
  slot: number;
  session: ClientSession;
  predictor: Predictor;
  buffer: SnapshotBuffer;
  pacer: TickPacer;
  bot: Bot | null;
  target: { x: number; y: number };
}

export class LocalMatch {
  readonly room: GameRoom;
  private readonly players: LocalPlayer[] = [];

  /** Slot the human controls, or `null` when both sides are bots. */
  readonly humanSlot: number | null;

  private started = 0;

  constructor(private readonly options: LocalMatchOptions) {
    this.humanSlot = options.mode === 'bot' ? 0 : null;

    // One codec instance for the room and one per client: the binary codec is
    // stateful, delta-encoding against a shared baseline.
    this.room = new GameRoom({ codec: createBinaryCodec() });

    for (let slot = 0; slot < PLAYER_COUNT; slot++) {
      const [serverEnd, clientEnd] = createLoopbackPair();

      const predictor = new Predictor(slot);
      const buffer = new SnapshotBuffer();
      const pacer = new TickPacer();

      const impaired = withSimulatedNetwork(clientEnd, options.conditions);
      const session = new ClientSession(impaired, {
        codec: createBinaryCodec(),
        now: () => performance.now(),
        onSnapshot: (snapshot: WireSnapshot) => {
          buffer.push(snapshot, performance.now());
          predictor.reconcile(snapshot);
          pacer.observe(snapshot.depth[slot] ?? 0);
        },
      });

      // Join only once the client is listening. `join` sends the welcome
      // synchronously over a loopback transport, so seating the peer first
      // would deliver it to a handler that does not exist yet and the client
      // would never learn its slot. The online path hides this because a real
      // socket handshake is asynchronous.
      this.room.join(serverEnd);

      this.players.push({
        slot,
        session,
        predictor,
        buffer,
        pacer,
        bot:
          slot === this.humanSlot
            ? null
            : new Bot({
                slot,
                // Sharp enough that a visitor watching for ten seconds sees a
                // real rally rather than two paddles ambling toward each other.
                difficulty: options.difficulty ?? 0.88,
                seed: (options.seed ?? 1) * 31 + slot,
              }),
        target: { x: RINK_WIDTH / 2, y: RINK_HEIGHT / 2 },
      });
    }
  }

  /** The view being rendered: the human's, or player 0's when spectating. */
  get viewSlot(): number {
    return this.humanSlot ?? 0;
  }

  view(slot = this.viewSlot): { predictor: Predictor; buffer: SnapshotBuffer } {
    const player = this.players[slot]!;
    return { predictor: player.predictor, buffer: player.buffer };
  }

  get rttMs(): number {
    return this.players[this.viewSlot]!.session.rttMs;
  }

  get ready(): boolean {
    return this.players.every((p) => p.session.ready);
  }

  /** Aim the human's paddle. Ignored while spectating. */
  setHumanTarget(x: number, y: number): void {
    if (this.humanSlot === null) return;
    this.players[this.humanSlot]!.target = { x, y };
  }

  /**
   * Advance one client tick, then one server tick.
   *
   * Clients first so their inputs are already buffered for the tick the server
   * is about to simulate — the same ordering the real deployment produces, just
   * without a network's worth of delay hiding it.
   */
  tick(nowMs: number): void {
    if (this.started === 0) this.started = nowMs;

    for (const player of this.players) {
      if (!player.session.ready) continue;

      if (player.bot) {
        // The bot sees what this client sees — its own predicted state — never
        // authoritative truth, which it has no honest way to know.
        const decision = player.bot.decide(player.predictor.getState());
        player.target = decision;
      }

      const aim = quantizeTarget(player.target.x, player.target.y);
      const ticks = player.pacer.ticksThisFrame();

      for (let i = 0; i < ticks; i++) {
        const tick = player.predictor.getState().tick + 1;
        player.session.queueInput({ seq: tick, x: aim.x, y: aim.y });
        player.predictor.predict({ seq: tick, targetX: aim.x, targetY: aim.y });
      }
    }

    this.room.tick();

    // Cheap, and it keeps the RTT readout meaningful in the local demo too.
    if (this.room.getState().tick % 60 === 0) {
      for (const player of this.players) player.session.sendPing();
    }
  }

  dispose(): void {
    for (const player of this.players) player.session.close();
  }
}
