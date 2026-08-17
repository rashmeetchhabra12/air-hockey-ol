# P0 spike: can a Durable Object host a 60 Hz authoritative loop?

**Verdict: yes.** The server design proceeds on Cloudflare Durable Objects.

## Why this was measured first

The whole server architecture assumes a Durable Object can act as an
authoritative fixed-timestep simulation host. Workers are built for short
request handlers, not sustained loops, so the assumption needed evidence before
anything was built on top of it. The fallback — a VPS behind the same transport
interface — is cheap to switch to early and expensive to switch to late.

## Result

30-second run, `wrangler dev` (workerd via Miniflare), one WebSocket client
connected, per-tick workload sized to match the real `step()`:

| Metric | Value |
|---|---|
| Wall elapsed | 30.01 s |
| Ticks simulated | 1800 |
| **Effective rate** | **59.99 Hz** (target 60) |
| Timer callbacks | 3753 |
| Max callback gap | 41 ms |
| Frozen-clock callbacks | 691 (18.4%) |
| Catch-up clamped | 0 |

1800 ticks is exactly the number 30 seconds at 60 Hz should produce. No drift,
no dropped backlog.

## The finding that actually mattered

**18.4% of timer callbacks observed `Date.now()` unchanged from the previous
callback.**

Workers deliberately freeze the clock during synchronous execution as a
timing-side-channel mitigation; it advances only across I/O boundaries. Nearly
one callback in five therefore sees a delta of zero.

This is exactly the kind of platform behaviour that silently breaks a naive
implementation. A loop written as "advance one tick per timer callback" would
have paced off timer jitter and run erratically. A loop written as "advance by
the elapsed wall-clock delta" would stall on every frozen callback and then
lurch forward on the next.

The accumulator design absorbs it correctly: a frozen callback contributes zero
to the accumulator and simply drains no ticks, and the following callback
contributes the full elapsed span. Ticks come out at exactly 60 Hz regardless.
`catchupClamped: 0` confirms the backlog never grew beyond the per-callback
catch-up budget.

The timer fires every 8 ms — deliberately finer than the 16.67 ms tick — so the
accumulator, not the timer, determines pacing.

## Caveats

- Measured against **workerd locally**, not deployed Cloudflare infrastructure.
  Production adds eviction and hibernation behaviour that local dev does not
  simulate. Re-run against a deployed Worker before P9.
- Single client, single room. Fan-out cost is untested.
- `wrangler` 3.114 caps the compatibility date at `2025-07-18`; the config
  requests a later one and falls back. Harmless for this measurement.

## Reproducing

```bash
npm run dev -w @ah/spike-do        # terminal 1
npm run measure -w @ah/spike-do    # terminal 2
```

`measure.mjs` exits non-zero if the effective rate drops below 57 Hz or a
callback gap exceeds 250 ms.
