/**
 * Human-versus-human, verified end to end.
 *
 * Drives two *real* clients — the same `ClientSession`, `Predictor`,
 * `SnapshotBuffer`, `TickPacer` and binary codec the browser runs — over real
 * WebSockets to the worker's Durable Object. The only thing missing compared to
 * two people at two keyboards is the pointer.
 *
 * This covers the one path the browser demo cannot check for itself, since the
 * spectator and bot modes never touch a socket.
 */

import { ClientSession, Predictor, SnapshotBuffer, TickPacer } from '@ah/netcode';
import { createBinaryCodec, quantizeTarget, webSocketTransport, type WebSocketLike } from '@ah/protocol';
import { RINK_HEIGHT, RINK_WIDTH, TICK_RATE, paddleBoundsX, clamp } from '@ah/sim';

const BASE = process.env['VERIFY_URL'] ?? 'ws://127.0.0.1:8787';
const ROOM = `hvh${Date.now() % 100000}`;
const RUN_MS = 8000;

interface Peer {
  label: string;
  socket: WebSocket;
  session: ClientSession;
  predictor: Predictor;
  buffer: SnapshotBuffer;
  pacer: TickPacer;
  slot: number | null;
  snapshots: number;
  bytes: number;
}

function connect(label: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${BASE}/ws?room=${ROOM}`);
    socket.binaryType = 'arraybuffer';

    const timer = setTimeout(() => reject(new Error(`${label}: connect timed out`)), 10_000);

    socket.addEventListener('error', () => reject(new Error(`${label}: socket error`)));
    socket.addEventListener('open', () => {
      clearTimeout(timer);

      const predictor = new Predictor(0);
      const buffer = new SnapshotBuffer();
      const pacer = new TickPacer();

      const peer: Peer = {
        label,
        socket,
        predictor,
        buffer,
        pacer,
        slot: null,
        snapshots: 0,
        bytes: 0,
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

      socket.addEventListener('message', (event: MessageEvent) => {
        peer.bytes += (event.data as ArrayBuffer).byteLength ?? 0;
      });

      resolve(peer);
    });
  });
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

console.log(`two clients -> ${BASE} room=${ROOM} (binary codec)\n`);

const a = await connect('A');
const b = await connect('B');
await new Promise((r) => setTimeout(r, 400));

check('both clients welcomed', a.slot !== null && b.slot !== null, `A=${a.slot} B=${b.slot}`);
check('distinct slots assigned', a.slot !== b.slot, `${a.slot} vs ${b.slot}`);

// Each peer chases the puck it can see, exactly as a player would.
const started = performance.now();
const loop = setInterval(() => {
  const elapsed = (performance.now() - started) / 1000;

  for (const peer of [a, b]) {
    if (peer.slot === null) continue;
    const bounds = paddleBoundsX(peer.slot);
    const seen = peer.buffer.newest();

    const wobble = Math.sin(elapsed * 2.4 + peer.slot) * 140;
    const target = quantizeTarget(
      clamp(seen ? seen.puck[0] : RINK_WIDTH / 2, bounds.minX, bounds.maxX),
      clamp((seen ? seen.puck[1] : RINK_HEIGHT / 2) + wobble, 40, RINK_HEIGHT - 40),
    );

    for (let i = 0, n = peer.pacer.ticksThisFrame(); i < n; i++) {
      const tick = peer.predictor.getState().tick + 1;
      peer.session.queueInput({ seq: tick, x: target.x, y: target.y });
      peer.predictor.predict({ seq: tick, targetX: target.x, targetY: target.y });
    }
  }
}, 1000 / TICK_RATE);

const pinger = setInterval(() => {
  for (const peer of [a, b]) peer.session.sendPing();
}, 1000);

const snapsAtStart = a.snapshots;
await new Promise((r) => setTimeout(r, RUN_MS));
clearInterval(loop);
clearInterval(pinger);

const rate = ((a.snapshots - snapsAtStart) / RUN_MS) * 1000;
check('snapshots arrive at ~20 Hz', rate > 16 && rate < 24, `${rate.toFixed(1)} Hz`);
check('both clients receive the stream', a.snapshots > 50 && b.snapshots > 50, `A=${a.snapshots} B=${b.snapshots}`);

const seenByA = a.buffer.newest()!;
const seenByB = b.buffer.newest()!;

check('both see the same match', Math.abs(seenByA.tick - seenByB.tick) < 20, `ticks ${seenByA.tick} / ${seenByB.tick}`);
check('scores agree', JSON.stringify(seenByA.score) === JSON.stringify(seenByB.score), `${seenByA.score} vs ${seenByB.score}`);

check(
  'each paddle moved from its home position',
  Math.abs(seenByA.pads[0]![0] - 200) > 30 && Math.abs(seenByA.pads[1]![0] - 800) > 30,
  `x=${seenByA.pads[0]![0].toFixed(0)} / ${seenByA.pads[1]![0].toFixed(0)}`,
);
check('paddles stayed in their own halves', seenByA.pads[0]![0] < 500 && seenByA.pads[1]![0] > 500);
check('the puck is being played', seenByA.touch >= 0 || (seenByA.score[0] ?? 0) + (seenByA.score[1] ?? 0) > 0);

check(
  'prediction is running ahead of the server',
  a.predictor.getState().tick > seenByA.tick,
  `lead ${a.predictor.getState().tick - seenByA.tick} ticks`,
);

const stats = a.predictor.getStats();
check('reconciliation is converging', stats.reconciliations > 50, `${stats.reconciliations} reconciles, ${stats.corrections} corrections`);
check('no snapshot was decoded as garbage', a.session.rejected === 0 && b.session.rejected === 0);

const kib = (bytes: number): string => ((bytes / RUN_MS) * 1000 / 1024).toFixed(2);
console.log(`\n  downstream: A ${kib(a.bytes)} KiB/s, B ${kib(b.bytes)} KiB/s (binary)`);
console.log(`  rtt: A ${a.session.rttMs.toFixed(1)} ms, B ${b.session.rttMs.toFixed(1)} ms`);
console.log(`  score: ${seenByA.score.join(' - ')}`);

for (const peer of [a, b]) peer.socket.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
