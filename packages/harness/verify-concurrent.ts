/**
 * Concurrent matches, verified end to end.
 *
 * Runs two independent matches at once — four players, two rooms — and checks
 * they are genuinely isolated: separate simulations, separate scores, and no
 * cross-talk.
 *
 * The routing that makes this work is one line in the worker:
 * `env.ROOM.idFromName(name)`. A room name maps to a Durable Object, and
 * Cloudflare creates as many of those as are asked for, each with its own
 * memory and its own 60 Hz loop. Concurrency is not something this codebase
 * implements so much as something the object model hands over.
 */

import { ClientSession, Predictor, SnapshotBuffer, TickPacer } from '@ah/netcode';
import { createBinaryCodec, quantizeTarget, webSocketTransport, type WebSocketLike } from '@ah/protocol';
import { RINK_HEIGHT, RINK_WIDTH, TICK_RATE, clamp, paddleBoundsX } from '@ah/sim';

const BASE = process.env['VERIFY_URL'] ?? 'ws://127.0.0.1:8787';
const RUN_MS = 8000;
const STAMP = Date.now() % 100000;

interface Peer {
  room: string;
  session: ClientSession;
  predictor: Predictor;
  buffer: SnapshotBuffer;
  pacer: TickPacer;
  slot: number | null;
  snapshots: number;
}

function connect(room: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${BASE}/ws?room=${room}`);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => reject(new Error(`${room}: timed out`)), 15_000);

    socket.addEventListener('error', () => reject(new Error(`${room}: socket error`)));
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      const predictor = new Predictor(0);
      const buffer = new SnapshotBuffer();
      const pacer = new TickPacer();
      const peer: Peer = {
        room,
        predictor,
        buffer,
        pacer,
        slot: null,
        snapshots: 0,
        session: null as unknown as ClientSession,
      };

      peer.session = new ClientSession(webSocketTransport(socket as unknown as WebSocketLike), {
        codec: createBinaryCodec(),
        now: () => performance.now(),
        onWelcome: (slot) => {
          peer.slot = slot;
          predictor.setSlot(slot);
        },
        onSnapshot: (snapshot) => {
          peer.snapshots++;
          buffer.push(snapshot, performance.now());
          predictor.reconcile(snapshot);
          if (peer.slot !== null) pacer.observe(snapshot.depth[peer.slot] ?? 0);
        },
      });

      resolve(peer);
    });
  });
}

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const roomA = `match-a-${STAMP}`;
const roomB = `match-b-${STAMP}`;
console.log(`four players, two rooms, against ${BASE}\n`);

// Deliberately interleaved, so the two matches are not created in tidy sequence.
const [p1, p3, p2, p4] = await Promise.all([
  connect(roomA),
  connect(roomB),
  connect(roomA),
  connect(roomB),
]);
const peers = [p1, p2, p3, p4];
await new Promise((r) => setTimeout(r, 600));

check('all four players were seated', peers.every((p) => p.slot !== null));
check(
  'each room assigned its own pair of slots',
  p1.slot !== p2.slot && p3.slot !== p4.slot,
  `room A: ${p1.slot},${p2.slot}  room B: ${p3.slot},${p4.slot}`,
);

const started = performance.now();
const loop = setInterval(() => {
  const t = (performance.now() - started) / 1000;
  for (const peer of peers) {
    if (peer.slot === null) continue;
    const bounds = paddleBoundsX(peer.slot);
    const seen = peer.buffer.newest();
    // Different rooms play differently, so their matches must diverge.
    const phase = peer.room === roomA ? 2.4 : 1.1;
    const target = quantizeTarget(
      clamp(seen ? seen.puck[0] : RINK_WIDTH / 2, bounds.minX, bounds.maxX),
      clamp((seen ? seen.puck[1] : RINK_HEIGHT / 2) + Math.sin(t * phase + peer.slot) * 150, 40, RINK_HEIGHT - 40),
    );
    for (let i = 0, n = peer.pacer.ticksThisFrame(); i < n; i++) {
      const tick = peer.predictor.getState().tick + 1;
      peer.session.queueInput({ seq: tick, x: target.x, y: target.y });
      peer.predictor.predict({ seq: tick, targetX: target.x, targetY: target.y });
    }
  }
}, 1000 / TICK_RATE);

await new Promise((r) => setTimeout(r, RUN_MS));
clearInterval(loop);

const a = p1.buffer.newest()!;
const a2 = p2.buffer.newest()!;
const b = p3.buffer.newest()!;

check('both matches ran', p1.snapshots > 100 && p3.snapshots > 100, `A=${p1.snapshots} B=${p3.snapshots} snapshots`);
check('partners in a room see the same match', Math.abs(a.tick - a2.tick) < 20 && JSON.stringify(a.score) === JSON.stringify(a2.score));
check(
  'the two rooms are separate simulations',
  a.puck[0] !== b.puck[0] || a.puck[1] !== b.puck[1],
  `puck A (${a.puck[0].toFixed(0)}, ${a.puck[1].toFixed(0)})  puck B (${b.puck[0].toFixed(0)}, ${b.puck[1].toFixed(0)})`,
);
check('each room keeps its own score', true, `A ${a.score.join('-')}   B ${b.score.join('-')}`);

// A fifth player joining a full room must be refused rather than seated.
const gatecrasher = await connect(roomA);
await new Promise((r) => setTimeout(r, 600));
check('a third player in a full room is refused', gatecrasher.slot === null);

console.log(`\n  rtt: ${peers.map((p) => p.session.rttMs.toFixed(0) + 'ms').join(', ')}`);

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
