/**
 * Drives the tick spike and reports what the Durable Object actually achieved.
 *
 * Uses Node's built-in global WebSocket (Node 22+), so the spike needs no
 * client-side dependency of its own.
 */

const URL_ = process.env.SPIKE_URL ?? 'ws://127.0.0.1:8787/ws';
const DURATION_MS = Number(process.env.SPIKE_DURATION_MS ?? 30_000);

const TARGET_HZ = 60;
/** Effective rate below this means the DO cannot host an authoritative loop. */
const PASS_HZ = 57;
/** A gap this long is a visible hitch for players; used as a secondary check. */
const MAX_ACCEPTABLE_GAP_MS = 250;

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

const socket = new WebSocket(URL_);
let last = null;
let opened = false;

const timeout = setTimeout(() => {
  if (!opened) {
    console.error(`\nFAIL: never connected to ${URL_} within 15s.`);
    console.error('Is `npm run dev -w @ah/spike-do` running?');
    process.exit(2);
  }
}, 15_000);

socket.addEventListener('open', () => {
  opened = true;
  clearTimeout(timeout);
  console.log(`connected to ${URL_}`);
  console.log(`measuring for ${DURATION_MS / 1000}s at a target of ${TARGET_HZ} Hz...\n`);
  // Report on a timer rather than waiting for the socket's own close event:
  // Miniflare does not reliably complete the closing handshake, so a
  // close-driven exit hangs indefinitely.
  setTimeout(finish, DURATION_MS);
});

socket.addEventListener('message', (event) => {
  last = JSON.parse(event.data);
  const seconds = (last.wallElapsedMs / 1000).toFixed(1);
  process.stdout.write(
    `\r  t=${seconds}s  ticks=${last.ticks}  effective=${last.effectiveHz.toFixed(2)} Hz  ` +
      `maxGap=${last.maxCallbackGapMs}ms  frozenClock=${last.frozenClockCallbacks}  ` +
      `clamped=${last.catchupClamped}   `,
  );
});

socket.addEventListener('error', (err) => {
  console.error('\nsocket error:', err.message ?? err);
  process.exit(2);
});

// If the server drops the connection first, report whatever was gathered.
socket.addEventListener('close', finish);

let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);

  try {
    socket.close();
  } catch {
    // Already closing; irrelevant to the measurement.
  }

  if (!last) {
    console.error('\nFAIL: connected but received no reports. The tick loop never ran.');
    process.exit(1);
  }

  console.log('\n\n--- result ---------------------------------------------');
  console.log(`wall elapsed        ${(last.wallElapsedMs / 1000).toFixed(2)} s`);
  console.log(`ticks simulated     ${last.ticks}`);
  console.log(`effective rate      ${last.effectiveHz.toFixed(2)} Hz  (target ${TARGET_HZ})`);
  console.log(`timer callbacks     ${last.timerCallbacks}`);
  console.log(`max callback gap    ${last.maxCallbackGapMs} ms`);
  console.log(
    `frozen-clock calls  ${last.frozenClockCallbacks} ` +
      `(${pct(last.frozenClockCallbacks / Math.max(1, last.timerCallbacks))} of callbacks)`,
  );
  console.log(`catch-up clamped    ${last.catchupClamped}`);
  console.log('--------------------------------------------------------');

  const rateOk = last.effectiveHz >= PASS_HZ;
  const gapOk = last.maxCallbackGapMs <= MAX_ACCEPTABLE_GAP_MS;

  if (rateOk && gapOk) {
    console.log('\nPASS: a Durable Object can host the authoritative 60 Hz loop.');
    process.exit(0);
  }

  console.log('\nFAIL:');
  if (!rateOk) console.log(`  effective rate ${last.effectiveHz.toFixed(2)} Hz is below ${PASS_HZ}`);
  if (!gapOk) console.log(`  max gap ${last.maxCallbackGapMs}ms exceeds ${MAX_ACCEPTABLE_GAP_MS}ms`);
  console.log('  Fall back to a VPS; the server core is transport-agnostic by design.');
  process.exit(1);
}
