/**
 * Matchmaking, verified end to end.
 *
 * Two players ask the lobby for a match, get paired, connect to the room they
 * were given, and play. Also checks the cases that a naive "count the players
 * and pair them up" design gets wrong: someone waiting alone, someone leaving
 * the queue, and two people arriving at the same instant.
 */

import { ClientSession, Predictor, SnapshotBuffer, TickPacer } from '@ah/netcode';
import {
  createBinaryCodec,
  decodeLobbyServer,
  encodeLobbyClient,
  quantizeTarget,
  webSocketTransport,
  type LobbyServerMessage,
  type WebSocketLike,
} from '@ah/protocol';
import { RINK_HEIGHT, RINK_WIDTH, TICK_RATE, clamp, paddleBoundsX } from '@ah/sim';

const BASE = process.env['VERIFY_URL'] ?? 'ws://127.0.0.1:8787';

const checks: Array<{ ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  checks.push({ ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** A player sitting in the matchmaking queue. */
function queueUp(name: string): {
  socket: WebSocket;
  messages: LobbyServerMessage[];
  matched: Promise<{ room: string; opponent: string }>;
} {
  const socket = new WebSocket(`${BASE}/lobby?name=${encodeURIComponent(name)}`);
  const messages: LobbyServerMessage[] = [];

  const matched = new Promise<{ room: string; opponent: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: never matched`)), 20_000);
    socket.addEventListener('open', () => socket.send(encodeLobbyClient({ t: 'find' })));
    socket.addEventListener('message', (event) => {
      const msg = decodeLobbyServer(event.data);
      if (!msg) return;
      messages.push(msg);
      if (msg.t === 'matched') {
        clearTimeout(timer);
        resolve({ room: msg.room, opponent: msg.opponent });
      }
    });
    socket.addEventListener('error', () => reject(new Error(`${name}: lobby socket error`)));
  });

  return { socket, messages, matched };
}

/** Join a room and play for a while. */
async function playIn(room: string, name: string, ms: number) {
  const socket = new WebSocket(`${BASE}/ws?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
  socket.binaryType = 'arraybuffer';
  const predictor = new Predictor(0);
  const buffer = new SnapshotBuffer();
  const pacer = new TickPacer();
  let slot: number | null = null;
  let roster: string[] = [];

  const session = await new Promise<ClientSession>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: room connect timed out`)), 15_000);
    socket.addEventListener('error', () => reject(new Error(`${name}: room socket error`)));
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(
        new ClientSession(webSocketTransport(socket as unknown as WebSocketLike), {
          codec: createBinaryCodec(),
          now: () => performance.now(),
          onWelcome: (s) => {
            slot = s;
            predictor.setSlot(s);
          },
          onRoster: (names) => {
            roster = names;
          },
          onSnapshot: (snap) => {
            buffer.push(snap, performance.now());
            predictor.reconcile(snap);
            if (slot !== null) pacer.observe(snap.depth[slot] ?? 0);
          },
        }),
      );
    });
  });

  const loop = setInterval(() => {
    if (slot === null) return;
    const bounds = paddleBoundsX(slot);
    const seen = buffer.newest();
    const aim = quantizeTarget(
      clamp(seen ? seen.puck[0] : RINK_WIDTH / 2, bounds.minX, bounds.maxX),
      clamp(seen ? seen.puck[1] : RINK_HEIGHT / 2, 40, RINK_HEIGHT - 40),
    );
    for (let i = 0, n = pacer.ticksThisFrame(); i < n; i++) {
      const tick = predictor.getState().tick + 1;
      session.queueInput({ seq: tick, x: aim.x, y: aim.y });
      predictor.predict({ seq: tick, targetX: aim.x, targetY: aim.y });
    }
  }, 1000 / TICK_RATE);

  await new Promise((r) => setTimeout(r, ms));
  clearInterval(loop);

  return { slot, roster, buffer, socket };
}

console.log(`matchmaking against ${BASE}\n`);

// --- A lone player waits, and is told so ------------------------------------
const lonely = queueUp('Solo');
await new Promise((r) => setTimeout(r, 1500));
check(
  'a lone player is queued rather than matched',
  lonely.messages.some((m) => m.t === 'queued') && !lonely.messages.some((m) => m.t === 'matched'),
  lonely.messages.map((m) => m.t).join(', '),
);

// --- A second player arrives and both are paired ----------------------------
const partner = queueUp('Duo');
const [first, second] = await Promise.all([lonely.matched, partner.matched]);

check('both players were matched', true, `room ${first.room}`);
check('both were sent the same room', first.room === second.room, `${first.room} / ${second.room}`);
check(
  'each was told the other name',
  first.opponent === 'Duo' && second.opponent === 'Solo',
  `${first.opponent} / ${second.opponent}`,
);

lonely.socket.close();
partner.socket.close();

// --- They can actually play in it -------------------------------------------
const [p1, p2] = await Promise.all([
  playIn(first.room, 'Solo', 4000),
  playIn(first.room, 'Duo', 4000),
]);

check('both joined the match', p1.slot !== null && p2.slot !== null, `slots ${p1.slot}, ${p2.slot}`);
check('they took different sides', p1.slot !== p2.slot);
check(
  'each sees both names',
  p1.roster.includes('Solo') && p1.roster.includes('Duo'),
  p1.roster.join(' vs '),
);
check('the match is running', (p1.buffer.newest()?.tick ?? 0) > 100, `tick ${p1.buffer.newest()?.tick}`);
p1.socket.close();
p2.socket.close();

// --- Cancelling leaves the queue empty --------------------------------------
const quitter = queueUp('Quitter');
await new Promise((r) => setTimeout(r, 800));
quitter.socket.send(encodeLobbyClient({ t: 'cancel' }));
await new Promise((r) => setTimeout(r, 500));
check('cancelling is acknowledged', quitter.messages.some((m) => m.t === 'cancelled'));
quitter.socket.close();
await new Promise((r) => setTimeout(r, 500));

// --- Simultaneous arrivals pair cleanly -------------------------------------
// The case a "count the players" design gets wrong. A Durable Object handles
// one request at a time, so the queue cannot be read and taken from at once.
const rush = ['R1', 'R2', 'R3', 'R4'].map(queueUp);
const paired = await Promise.all(rush.map((r) => r.matched));
const rooms = new Set(paired.map((p) => p.room));
check('four simultaneous arrivals formed two matches', rooms.size === 2, `${rooms.size} rooms`);
check(
  'nobody was matched with themselves or double-booked',
  paired.every((p, i) => p.opponent !== ['R1', 'R2', 'R3', 'R4'][i]),
);
for (const r of rush) r.socket.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
