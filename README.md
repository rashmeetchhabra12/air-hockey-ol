# Networked Air Hockey

**Live: <https://air-hockey-ol.rashmeetsingh1012.workers.dev>**

Two-player air hockey over WebSockets, built to demonstrate real-time state
synchronisation: client-side prediction, server reconciliation, lag
compensation, and transient authority over a contested object.

Pick a name and choose an opponent. **Play vs bot** and **Watch two bots** run
entirely in the page — it hosts its own authoritative room, simulated network,
and both clients, so there is nothing to wait for. **Play vs human** queues you
for matchmaking *while you play the bot*, and swaps you across when someone is
found.

Drag **Latency** to 250 ms and toggle **Netcode** off and on.

> **Status: P9 of 11 — deployed.** Prediction, reconciliation, interpolation, a headless
> measurement harness, all three puck strategies, lag compensation, a binary
> wire protocol, and a scripted bot with a spectator mode that needs no server
> at all. Next is deployment.

## Running it

```bash
npm install
npm run dev:client    # Vite on :5173
```

Open <http://localhost:5173>. **That is the whole setup** — the page opens
straight into a match between two bots and needs no server, because it hosts the
authoritative room, the simulated network, and both clients itself. Only
*Play vs human* needs the worker:

```bash
npm run dev:server    # Durable Object on :8787 (wrangler)
```

**Try this.** Drag latency to 250 ms, then toggle **Netcode** off and on. Off is
the P1 path — raw server state, so the paddle trails by half the round trip. On,
it tracks exactly. Tick **Debug overlay** to draw authoritative positions as
dashed ghosts; when prediction is right they sit on top of the paddle.

**Then switch the puck strategy.** *A — interpolate* shows real snapshot data,
so strikes feel delayed. *B — predict* responds instantly, but the puck jumps
when the opponent plays it. *C — authority* predicts only while the `puck owner`
readout says `you`. Watch that readout change as the puck crosses the rink.

```bash
npm test              # 235 tests: determinism, physics, protocol, room, netcode, bot, harness
npm run typecheck     # all packages, including the two Worker ones
npm run measure       # regenerate MEASUREMENTS.md (add -- --seconds 60 for a longer run)
```

Deployment steps are in [DEPLOY.md](DEPLOY.md). One Worker serves the built
client and runs the game room, so the page and its socket share an origin.

## Layout

| Package | Role |
|---|---|
| `sim` | Deterministic simulation. No I/O, no wall clock, no unseeded randomness. |
| `protocol` | Wire format, codec, and the `Transport` seam. |
| `netcode` | Prediction, reconciliation, interpolation, session. Runtime-agnostic. |
| `server` | Authoritative room and fixed-timestep loop. Transport- and runtime-agnostic. |
| `worker` | Cloudflare Durable Object adapter. One room per match. |
| `client` | Canvas renderer, input, and a thin WebSocket wrapper. |
| `bot` | Scripted opponent. Predicts by rolling the real simulation forward. |
| `harness` | Headless measurement across a simulated network. |
| `spike-do` | P0 architectural spike. See [its results](packages/spike-do/RESULTS.md). |

`sim` is imported verbatim by both client and server. There is exactly one
implementation of the game rules, so prediction and authority can never disagree
about what *should* have happened — only about which inputs each side had seen.
That distinction is the reason reconciliation is able to converge at all.

`netcode` is a package rather than a folder inside `client` for the same kind of
reason: nothing in it touches the DOM, a socket, or a clock it was not handed, so
the harness drives *that exact code* rather than a reimplementation. A benchmark
that measures a copy of the system measures nothing.

## Notes from the build so far

**Determinism is a tested property, not an aspiration.** ECMAScript requires
`+ - * /` and `Math.sqrt` to be correctly rounded, so they are bit-identical
across engines. The transcendental family carries no such guarantee, and
`Math.hypot` is the trap — it looks like exactly the right tool for a vector
length and is not correctly rounded. The simulation is written to need none of
them, and [a test scans the source](packages/sim/test/determinism.test.ts) to
keep it that way. A separate test asserts that replaying from any snapshot point
reproduces the original run bit-for-bit, which is precisely what reconciliation
will do.

**Workers freeze `Date.now()`.** The P0 spike measured ~18% of timer callbacks
observing zero elapsed time — a deliberate timing-side-channel mitigation, since
the clock only advances across I/O boundaries. Both obvious loop designs break
on it, so [the loop](packages/server/src/loop.ts) derives its tick count from
total elapsed time multiplied by the integer tick rate. Multiplying rather than
repeatedly subtracting an inexact `1000/60` also removes the drift that had the
spike reading 59.99 Hz instead of a flat 60.

**Collision detection is continuous.** At its speed ceiling the puck covers 30
units per tick against an 18-unit radius, so discrete stepping would send it
through paddles and walls. A 20,000-tick test with paddles thrashing at full
speed asserts it never escapes the rink.

**Reconciliation is exact, and tested as such.** A snapshot describes the world
half a round trip ago. The client keeps its own simulation, applies input
immediately, and on every snapshot throws the prediction away, adopts
authoritative state, and replays the inputs the server had not yet consumed.
Because `step()` is deterministic and both sides run the same module, the
combined input sequence is exactly the uninterrupted one — so
[the test](packages/client/test/prediction.test.ts) asserts the predicted state
is **bit-identical** to a simulation that never involved a network. "Close
enough" would pass while a real divergence quietly accumulated. It holds at lags
from 1 to 60 ticks, and with 80% of snapshots dropped.

**Interpolation is a separate mechanism, not a detail.** Prediction fixes your
own paddle and does nothing for the opponent's, whose input has not reached you.
Remote entities are drawn deliberately *in the past*, far enough back that two
snapshots always bracket the render time, so their motion is interpolated
between known-true states instead of guessed. This is the half people forget;
prediction alone leaves the opponent stuttering at the snapshot rate.

**Everything hashed must be on the wire.** Two fields looked derivable and were
not — paddle seek targets, and the tick of the last puck strike. A paddle keeps
moving toward its stored target on ticks with no input, and reconciliation
replays only your *own* inputs, so a missing target leaves the opponent frozen
during replay while the server keeps moving them into the puck. The touch tick
was worse: it participates in the state hash, so omitting it desynced clients
only at certain tick counts. There is now
[a test](packages/protocol/test/codec.test.ts) that round-trips a
fully-populated state and compares hashes, so a field added later is covered
automatically rather than silently forgotten.

## Measured

Full report in [MEASUREMENTS.md](MEASUREMENTS.md); regenerate with `npm run
measure`. The harness runs the real room, loop, session, predictor, and buffer
across a simulated network on a virtual clock — so a minute of gameplay measures
in milliseconds, and every run replays exactly from its seed.

**What the netcode is worth.** On-screen paddle position versus a zero-latency
local game, in rink units (the rink is 1000 x 600; a paddle is 34 across).

| RTT | netcode off (p50) | netcode off (p99) | **netcode on (p50)** | **netcode on (p99)** |
|---:|---:|---:|---:|---:|
| 0 ms | 15.0 | 86.4 | **0.0** | **0.0** |
| 100 ms | 11.1 | 64.9 | **0.0** | **0.0** |
| 200 ms | 42.6 | 260.0 | **0.0** | **8.9** |
| 300 ms | 266.1 | 266.7 | **0.0** | **28.3** |

**Wire format.** Measured over identical gameplay, both codecs, per client:

| Conditions | JSON down | **binary down** | JSON up | **binary up** | reduction |
|---|---:|---:|---:|---:|---:|
| clean 100 ms | 8.18 KiB/s | **1.00 KiB/s** | 5.71 KiB/s | **0.63 KiB/s** | 88% |
| 200 ms + 50 ms jitter | 8.02 KiB/s | **0.99 KiB/s** | 5.63 KiB/s | **0.63 KiB/s** | 88% |

Correction error is 0.0 under both, so the quantisation is invisible in practice
even though it is provably lossy.

**What TCP costs.** One-way delivery latency, measured. A lost packet is
retransmitted rather than dropped, and everything behind it waits.

| Loss | datagram p99 | **TCP-like p99** |
|---|---:|---:|
| 1% | 70 ms | **140 ms** |
| 5% | 70 ms | **186 ms** |
| 10% | 70 ms | **283 ms** |

This is the honest answer to "why not UDP?", and it is a number rather than an
opinion. Note the median barely moves — at a 20 Hz snapshot rate only two or
three packets queue behind a 120 ms retransmit. Send ten times more often and
head-of-line blocking drags the median out too.

**How stale the puck looks** under strategy A, in milliseconds behind
authoritative. Expected value is the 100 ms interpolation delay plus half the
round trip, and the measurement lands on it:

| RTT | 0 | 50 | 100 | 200 | 300 |
|---|---:|---:|---:|---:|---:|
| expected | 100 | 125 | 150 | 200 | 250 |
| measured p50 | 100 | 117 | 150 | 200 | 250 |

**Puck strategies, head to head.** How wrong the displayed puck was about the
moment it claimed to depict, in rink units — recorded when the client draws tick
T, resolved once the server reaches T. `jump/s` counts frames where the puck
moved further than it physically could, which is a visible teleport rather than
motion. The puck is 18 units across.

| RTT | A p50 | A p99 | A jump/s | B p50 | B p99 | B jump/s | **C p50** | **C p99** | **C jump/s** |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 ms | 170.7 | 298.2 | 0.0 | 0.0 | 44.1 | 0.3 | **136.2** | **291.1** | **0.1** |
| 100 ms | 63.2 | 427.7 | 0.1 | 0.0 | 135.5 | 0.5 | **0.0** | **440.3** | **0.2** |
| 200 ms | 249.2 | 530.3 | 0.1 | 0.0 | 277.4 | 0.7 | **132.3** | **494.5** | **0.5** |
| 300 ms | 285.2 | 599.7 | 0.2 | 0.0 | 456.3 | 1.4 | **124.3** | **573.1** | **0.6** |

**No strategy wins outright, and that is the honest result.** B is the most
accurate and the least smooth. A is the smoothest and the least accurate. C sits
between them on both. Accuracy alone cannot see the whole tradeoff: a puck that
is consistently late still moves smoothly, while one that is usually exact but
occasionally snaps sideways reads as broken.

What C actually buys is *where* its accuracy goes. Split by who held authority:

| RTT | C, while you own it (p50) | C, while you do not (p50) | owned |
|---:|---:|---:|---:|
| 50 ms | **2.6** | 153.6 | 19% |
| 100 ms | **0.0** | 176.0 | 72% |
| 200 ms | **7.2** | 212.3 | 42% |
| 300 ms | **2.5** | 253.6 | 39% |

When you are the one about to hit the puck, C is as exact as B. When your
opponent is playing it, C shows real data late instead of guessing. The frames
it is "wrong" about are the ones you are watching rather than playing.

| | |
|---|---|
| Durable Object tick rate | 59.99 Hz sustained over 30 s, zero catch-up clamping |
| Reconciliation error, clean link | 0.00 units — prediction is exact, not approximate |
| Bandwidth, JSON | 3.10 KiB/s up, 4.71 KiB/s down per client |

**Measure the right thing.** Two metrics had to be redesigned after they
produced nonsense. Puck staleness was first measured as *distance* from the
authoritative puck — but that scales with puck speed, which varies between
scenarios because the bots play differently under different latency, so the
result was not even monotonic in RTT. Measuring it as *time* instead gives a
figure with a predictable expected value, which is what makes it checkable.
Paddle lag had the same problem in reverse: a parked paddle agrees with every
timeline, so including idle frames measured how often the bot happened to be
still. Both metrics now exclude the samples where they are ill-conditioned, and
say so.

**Corrections are eased, except when they shouldn't be.** A predicted puck that
disagrees with the server by twenty units is drift, and blending it away over
~110 ms hides the correction entirely. One that disagrees by four hundred units
is not drift — it is a goal reset or a collision that resolved differently — and
easing across that sends the puck gliding over the rink to catch up, which reads
as a bug and hides the event that caused it. Small errors smooth, large ones
snap.

**Inputs are stamped with the tick they were simulated at.** Before P6 the
server applied each input at whatever tick it happened to arrive, so client and
server ran the same inputs at *different* moments — the paddle ended up in the
right place at the wrong time, which is exactly how a strike that plainly
connected on screen comes to miss. Now each input names its tick and the server
applies it there, rewinding and replaying if it arrives after that tick has
already been simulated. The window is 15 ticks (250 ms): long enough to cover a
bad connection, short enough that the past being rewritten is still recognisably
the present for the other player, and bounded so a client cannot claim an
arbitrarily stale moment.

**Rewinding does not reduce corrections — it slightly increases them.** Revising
the server's past means a client that already reconciled against the
pre-revision snapshot has to be nudged again. The benefit is not smoothness, it
is that the input lands where it was meant to, and
[a test asserts exactly that](packages/server/test/rewind.test.ts): a late input
must produce the same state as one that was never late. Claiming rewind improves
the correction metric would have been easy and wrong.

**How far ahead to run is a real tradeoff, not a constant.** Tick-stamped inputs
only work if the client leads the server by more than the one-way delay, so it
steers its lead using the buffer depth the server reports. Setting that target
too low left the client starved on 40% of ticks at 300 ms RTT. Raising it to six
drove late inputs to zero — and simultaneously pushed the *predicted puck's*
error from ~7 units to ~95, because running further ahead means predicting
further ahead, and a longer prediction is a worse one. Three is the measured
middle: few enough late inputs that rewind absorbs them invisibly, and a lead
short enough to keep the prediction worth having.

**The demo needs no server, which is the point.** The most common way a
multiplayer portfolio project fails is that someone opens it alone, finds nobody
to play, and closes the tab. So the page hosts its own `GameRoom` and connects
two bots to it across the same `withSimulatedNetwork` wrapper the online client
uses. Nothing is mocked — real room, real session, real predictor, real codec,
with latency and loss applied between them. Latency slider, netcode toggle, puck
strategies and debug overlay all work from static hosting, instantly, on a phone,
with no second player.

**The bot predicts by running the real simulation.** Given a deterministic,
side-effect-free `step()`, rolling the world forward to find where the puck will
arrive costs almost nothing to write — and unlike a linear extrapolation it
anticipates wall bounces and post ricochets correctly. It is the same property
that makes rollback and the headless harness possible, used for a third purpose.
It is spoiled deliberately: it acts on a view a few ticks old and aims slightly
off, both scaled by difficulty, because a bot with perfect information is
unplayable and boring.

**The wire format buys 88% at a stated price.** Three separate savings: no field
names, 16-bit fixed point instead of `float64`, and a bitmask naming only the
field groups that changed since the previous snapshot. Measured over identical
gameplay, 8.18 KiB/s down becomes 1.00 KiB/s.

The price is bit-exact state reconstruction — the property tested since P2. A
client adopting a JSON snapshot resumes from the server's exact numbers;
quantised, it resumes from rounded ones, so replay can no longer be identical.
[A test asserts exactly that](packages/protocol/test/binary.test.ts): JSON
reproduces the state hash and binary provably does not. It does not surface in
practice — the rounding step is ~0.018 units against a 0.05 correction dead
zone, reconciliation re-syncs every 3 ticks, and measured correction error is
0.0 for both codecs — but it is a real property traded away, not a free win.

Delta encoding here needs no keyframe recovery protocol, because the transport
is TCP and no snapshot is ever missing. That is a dividend from the transport
choice worth naming beside its cost: the same reliability that produces
head-of-line blocking is what makes delta encoding a bitmask rather than a
subsystem.

**Matchmaking is a queue, not a head-count.** The tempting design — count who
is online and pair them if the number is even — breaks on the cases that
actually happen: someone leaves mid-count, two people arrive in the same
millisecond, a player is paired with a tab that has already closed. A queue
needs none of that arithmetic, and parity falls out for free: an odd number of
players means exactly one person is waiting, by definition.

A Durable Object suits it unusually well because it is **single-threaded**.
"Is anyone waiting? Take them" cannot interleave with another player doing the
same thing, so the race that would need a lock elsewhere cannot occur.
[A test](packages/harness/verify-matchmaking.ts) fires four players at the lobby
simultaneously and checks they form exactly two matches with nobody
double-booked.

The lobby also never touches the match — it hands out a room name and steps
back. That is deliberate: a Durable Object is created wherever it is first
accessed, so a lobby that opened the room itself would pin every match to the
lobby's region rather than to one of the players'.

**Authority is derived, not claimed.** The server simulates all the physics, so
it already knows where the puck is and who is near it. A protocol where clients
*claim* the puck would add a conflict-resolution problem, an attack surface, and
no information the server did not already hold — so ownership is a pure function
of authoritative state, computed identically on both sides. The genuine
concurrency question, what happens when both players strike in the same tick, is
settled inside the collision solver: contacts resolve in time-of-impact order and
exact ties break by slot index, deterministically, so every participant reaches
the same answer without negotiating. Two rules make it work in practice —
hysteresis at the centre line, so a puck loitering there does not flip ownership
every few ticks, and a *directional* contest test, because the opposing paddle
sits permanently pinned at the line and a paddle behind a receding puck cannot
reach it.

**Measurement bugs outnumbered code bugs.** Three of them mattered. The harness
bots chased the puck's x clamped into their own half, which pinned the opposing
paddle against the centre line where it jammed the puck — 98% of play in one
half, authority permanently contested, and every puck number meaningless. The
teleport detector used a hardcoded threshold that flagged legitimate catch-up as
a jump, making strategy C look worse than it was; it is now derived from the
simulation and blend constants. And the handoff crossfade closed a ~600-unit gap
over 130 ms, moving the puck at 2.5× its own speed limit — a blend that was
itself the artefact it existed to prevent, now rate-capped.

## Known open questions

Paddle lag with prediction on is 0.00 units at the median for every latency, but
its p99 grows to ~28 units at 300 ms RTT where it used to be 0. Steady-state
late inputs, rewinds, and reconciliation corrections all measure zero at that
latency, so it is none of the obvious candidates, and the harness's tick-skew
instrumentation reads exactly 0. The bound in the tests is deliberately loose
and commented as such rather than tightened around a number whose cause is not
yet understood.

## Roadmap

P0 spike and simulation core, P1 naive networking, P2 prediction and
reconciliation, P3 measurement harness, P4 puck prediction, P5 transient
authority, P6 lag compensation, P7 binary protocol, P8 bot and spectator mode
**← here**, P9 deploy. Full plan in `~/.claude/plans/hi-i-am-goofy-tulip.md`.
