/**
 * End-to-end smoke test against a running worker.
 *
 * Connects real clients over real WebSockets to the real Durable Object and
 * asserts the authoritative loop behaves: slots are assigned, snapshots arrive
 * at the expected rate, input moves the right paddle, and the puck can be
 * struck. Complements the unit tests, which exercise the room over a loopback
 * transport with no runtime involved.
 *
 * Speaks JSON for the main body so the assertions can read fields directly,
 * then opens a second room to confirm the binary codec works over a real socket.
 * A room cannot mix wire formats: the binary codec delta-encodes against one
 * shared baseline, so every peer must be reading the same stream.
 */

const BASE = process.env.SMOKE_URL ?? 'ws://127.0.0.1:8787';
const ROOM = `smoke${Date.now() % 100000}`;
const RUN_MS = 4000;

/**
 * How far ahead of the server to stamp inputs.
 *
 * Inputs carry the tick they were simulated at, and the server applies each one
 * there. Stamping the current tick would be too late by the time the packet
 * lands, so a real client runs ahead — see `TickPacer`. This is the crude
 * fixed-lead equivalent.
 */
const LEAD_TICKS = 12;

function connect(label, { codec = 'json' } = {}) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}/ws?room=${ROOM}${codec === 'json' ? '&codec=json' : 'bin'}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const peer = { label, socket, welcome: null, snaps: [], bytes: 0, frames: 0 };

    const timer = setTimeout(() => reject(new Error(`${label}: connect timed out`)), 10_000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(peer);
    });
    socket.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${e.message ?? 'socket error'}`));
    });
    socket.addEventListener('message', (event) => {
      peer.frames++;
      if (typeof event.data === 'string') {
        peer.bytes += event.data.length;
        const msg = JSON.parse(event.data);
        if (msg.t === 'welcome') peer.welcome = msg;
        else if (msg.t === 'snap') peer.snaps.push(msg);
      } else {
        peer.bytes += event.data.byteLength;
      }
    });
  });
}

/** Newest tick this peer has seen, so inputs can be stamped ahead of it. */
function serverTick(peer) {
  const last = peer.snaps[peer.snaps.length - 1];
  return last ? last.tick : (peer.welcome?.tick ?? 0);
}

function sendInput(peer, x, y) {
  const tick = serverTick(peer) + LEAD_TICKS;
  peer.socket.send(JSON.stringify({ t: 'in', inputs: [{ seq: tick, x, y }] }));
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

console.log(`connecting two clients to ${BASE} room=${ROOM} (json codec)\n`);

const a = await connect('A');
const b = await connect('B');
await new Promise((r) => setTimeout(r, 300));

check('both clients were welcomed', a.welcome !== null && b.welcome !== null);
check(
  'slots assigned distinctly',
  a.welcome?.slot === 0 && b.welcome?.slot === 1,
  `A=${a.welcome?.slot} B=${b.welcome?.slot}`,
);
check('server reports 60 Hz', a.welcome?.tickRate === 60, `${a.welcome?.tickRate}`);

// Drive both paddles toward the centre so they meet and strike the puck.
const started = Date.now();
const driver = setInterval(() => {
  const t = (Date.now() - started) / 1000;
  const sweep = 300 + Math.sin(t * 3) * 120;
  sendInput(a, 460, sweep);
  sendInput(b, 540, sweep);
}, 1000 / 60);

const snapsAtStart = a.snaps.length;
await new Promise((r) => setTimeout(r, RUN_MS));
clearInterval(driver);

const received = a.snaps.length - snapsAtStart;
const rate = (received / RUN_MS) * 1000;
check('snapshots arrive at ~20 Hz', rate > 17 && rate < 23, `${rate.toFixed(1)} Hz`);

const first = a.snaps[snapsAtStart];
const last = a.snaps[a.snaps.length - 1];

check(
  'server tick advanced at ~60 Hz',
  Math.abs((last.tick - first.tick) / (RUN_MS / 1000) - 60) < 4,
  `${((last.tick - first.tick) / (RUN_MS / 1000)).toFixed(1)} Hz`,
);

check('input acknowledged for both slots', last.acks[0] > 0 && last.acks[1] > 0, `acks=${last.acks}`);
check('paddle 0 moved from its home position', Math.abs(last.pads[0][0] - 200) > 50, `x=${last.pads[0][0].toFixed(1)}`);
check('paddle 0 stayed in its own half', last.pads[0][0] < 500, `x=${last.pads[0][0].toFixed(1)}`);
check('paddle 1 stayed in its own half', last.pads[1][0] > 500, `x=${last.pads[1][0].toFixed(1)}`);
check('seek targets are on the wire', Array.isArray(last.tgts) && last.tgts.length === 2);
check('last-touch tick is on the wire', typeof last.touchTick === 'number');
check('input buffer depth is reported', Array.isArray(last.depth) && last.depth.length === 2);

// Acks tell a client which inputs are settled history. Going backwards would
// make it replay already-applied inputs and run away from the server.
const ackSeries = a.snaps.slice(snapsAtStart).map((s) => s.acks[0]);
check(
  'acks advance monotonically',
  ackSeries.every((v, i) => i === 0 || v >= ackSeries[i - 1]),
);

// Every field participating in the state hash must be present, or a reconciled
// client is provably out of step with the server.
const required = ['tick', 'puck', 'pads', 'tgts', 'score', 'frz', 'touch', 'touchTick', 'own', 'ownEp', 'acks', 'depth'];
const missing = required.filter((k) => last[k] === undefined);
check('snapshot carries every hashed field', missing.length === 0, missing.join(',') || 'complete');

const puckMoved = a.snaps.slice(snapsAtStart).some((s) => Math.abs(s.puck[2]) > 1 || Math.abs(s.puck[3]) > 1);
check('puck was struck and moved', puckMoved);

check(
  'both clients received the same snapshot stream',
  a.snaps.length === b.snaps.length,
  `A=${a.snaps.length} B=${b.snaps.length}`,
);

const c = await connect('C');
await new Promise((r) => setTimeout(r, 300));
check('third client refused', c.welcome === null);

// ---------------------------------------------------------------------------
// Binary codec, in its own room.
// ---------------------------------------------------------------------------

console.log('\nconnecting to a second room with the binary codec\n');

const bin = await connect('BIN', { codec: 'binary' });
await new Promise((r) => setTimeout(r, RUN_MS));

check('binary codec delivers frames', bin.frames > 20, `${bin.frames} frames`);
check('binary frames carry bytes', bin.bytes > 0, `${bin.bytes} bytes`);

const jsonPerSecond = (a.bytes / RUN_MS) * 1000;
const binPerSecond = (bin.bytes / RUN_MS) * 1000;
check(
  'binary is substantially smaller than JSON',
  binPerSecond < jsonPerSecond * 0.5,
  `${(binPerSecond / 1024).toFixed(2)} vs ${(jsonPerSecond / 1024).toFixed(2)} KiB/s`,
);

console.log(
  `\n  bandwidth per client: JSON ${(jsonPerSecond / 1024).toFixed(2)} KiB/s, ` +
    `binary ${(binPerSecond / 1024).toFixed(2)} KiB/s`,
);

for (const peer of [a, b, c, bin]) peer.socket.close();

const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
