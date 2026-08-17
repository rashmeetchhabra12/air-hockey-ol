# Deploying

Two independent pieces, and they are worth understanding separately:

| Piece | Where | Needed for | Cost |
|---|---|---|---|
| **Client** | Cloudflare Pages (static) | Everything a visitor sees by default | Free |
| **Worker** | Cloudflare Durable Object | Human-vs-human only | Free tier |

The client hosts its own authoritative room, simulated network, and both
clients in the page. So **the demo works with no server at all** — the latency
slider, netcode toggle, puck strategies, and debug overlay all function from
static hosting. The worker is only involved when two people play each other.

That means step 2 can be skipped entirely, or done later, without the link being
broken in the meantime.

---

## 1. Push to GitHub

The repository has no commits and no remote yet.

```bash
# Rename to the branch name GitHub and the CI workflow both expect.
git branch -m master main

git add -A
git commit -m "Networked air hockey: deterministic sim, prediction, reconciliation, lag compensation"

# Create an empty repo on github.com first (no README, no .gitignore), then:
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `dist`, and `.wrangler`, so the
push is source only.

**Check the commit author before pushing.** Commits will be attributed to
whatever `git config user.email` returns, and only an address attached to your
GitHub account produces contribution history on your profile:

```bash
git config user.email          # currently: rashmeetsingh1012@gmail.com
git config user.email "the-address-on-your-github-account"
```

Once pushed, the workflow in `.github/workflows/ci.yml` runs typecheck, 239
tests, the client build, and the measurement harness on every push to `main`.

---

## 2. Deploy the worker (optional — human-vs-human only)

```bash
npx wrangler login          # opens a browser; one time only
cd packages/worker
npx wrangler deploy
```

That prints a URL like `https://air-hockey.<your-subdomain>.workers.dev`.

Verify it before wiring the client to it — this drives two real clients through
the deployed Durable Object and checks twelve things about the match:

```bash
VERIFY_URL=wss://air-hockey.<your-subdomain>.workers.dev npm run verify:online
```

Notes:

- `wrangler.toml` already declares the Durable Object as `new_sqlite_classes`,
  which is the class available on the Workers **free** plan.
- Free tier is 1M requests and 400K GB-s per month. Outgoing WebSocket messages
  are not billed at all, and snapshot broadcast is the bulk of the traffic.

---

## 3. Deploy the client to Pages

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to
Git**, pick the repo, then set:

| Setting | Value |
|---|---|
| Framework preset | None |
| Build command | `npm install && npm run build -w @ah/client` |
| Build output directory | `packages/client/dist` |
| Root directory | *(leave blank — the repo root)* |

If you deployed the worker in step 2, add one environment variable so
human-vs-human finds it:

| Variable | Value |
|---|---|
| `VITE_SERVER_URL` | `wss://air-hockey.<your-subdomain>.workers.dev` |

It must be `wss://`, not `https://` — it is a WebSocket origin, and a page
served over HTTPS cannot open an insecure `ws://` socket.

Without the variable the client falls back to `ws://127.0.0.1:8787`, so
spectate and vs-bot still work and only *Play vs human* fails to connect.

---

## 4. Check the deployment

Open the Pages URL. It should be playing two bots within a second, with no
interaction.

- Drag **Latency** to 250 ms, then toggle **Netcode** off and on
- Switch **Mode → Play vs human**, and open the same URL in a second tab
- Open it on a phone: the spectator view needs no input, and touching the rink
  hands you a paddle

Useful URL parameters:

| Parameter | Effect |
|---|---|
| `?mode=online` | Open straight into human-vs-human |
| `?mode=bot` | Open straight into vs-bot |
| `?room=name` | Join a named room instead of `default` |
| `?server=wss://…` | Override the worker URL without rebuilding |
| `?codec=json` | Use the JSON wire format, readable in the network tab |

---

## Custom domain (optional)

Pages gives you `<project>.pages.dev` for free, which is perfectly good for a
portfolio link. A custom domain costs roughly $10–12/year and is configured
under **Custom domains** in the Pages project.
