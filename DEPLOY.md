# Deploying

**One Worker serves everything.** It hosts the built client as static assets and
runs the authoritative game room, so the page and its WebSocket share an origin.
That means no build-time server URL to configure and nothing to keep in sync
when the deployment moves — the page simply opens a socket back to wherever it
was served from.

Requests matching a built file are served as assets; anything else falls through
to the Worker, which is how `/ws` reaches the Durable Object. `not_found_handling`
is deliberately left at its default: single-page-application handling would
swallow `/ws` and answer the WebSocket upgrade with `index.html`.

Worth knowing: the client hosts its own room and two bots in the page, so the
spectator and vs-bot modes never touch the network at all. Only human-vs-human
uses the Durable Object.

---

## 1. GitHub

Already done — `main` is pushed to
<https://github.com/rashmeetchhabra12/air-hockey-ol>. `.gitignore` keeps
`node_modules`, `dist` and `.wrangler` out, so the repository is source only.

The workflow in `.github/workflows/ci.yml` runs typecheck, 239 tests, the client
build, and the measurement harness on every push to `main`.

---

## 2. Deploy

The client must be built first, because the Worker serves its output.

```bash
npx wrangler login                      # opens a browser; one time only
npm install
npm run build -w @ah/client
npx wrangler deploy -c packages/worker/wrangler.toml
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

## 3. Or deploy from Git (Workers Builds)

To redeploy automatically on every push, connect the repo under
**Workers & Pages → Create → Workers → Connect to Git** and set:

| Setting | Value |
|---|---|
| Build command | `npm install && npm run build -w @ah/client` |
| Deploy command | `npx wrangler deploy -c packages/worker/wrangler.toml` |
| Root directory | *(leave blank — the repo root)* |

The deploy command is the part worth getting right. A bare `npx wrangler deploy`
runs from the repository root, finds no configuration there, and fails with
*"Missing entry-point to Worker script or to assets directory"* — the build
having already succeeded.

`VITE_SERVER_URL` is not needed: the client defaults to its own origin in
production. Set it only to point a deployment at a *different* server.

---

## 4. Check the deployment

Open the `workers.dev` URL. It should be playing two bots within a second, with
no interaction.

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

`<worker>.<subdomain>.workers.dev` is free and perfectly good for a portfolio
link. A custom domain costs roughly $10–12/year and is configured under the
Worker's **Domains & Routes** settings.
