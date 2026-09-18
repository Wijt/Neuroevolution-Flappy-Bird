# Flappy Jev

Neuroevolution Flappy Bird, with a third mode: **watch Jev**. TypeSafe's Jev model
(a System One decision model) plays the game live. Play and Train modes are unchanged.

## Run

Requires Node.js 22.9+ (24 tested). No npm dependencies.

```powershell
npm start
```

Open http://localhost:3000 → **watch Jev** → paste your TypeSafe API key → **Start**.
Keys come from https://console.typesafe.ai.

Alternatively copy `.env.example` to `.env`, set `TYPESAFE_API_KEY`, restart, and leave
the browser field empty. A key typed in the browser wins over `.env`. The browser key
lives only in the page for the current watch session; it is never stored, and it is only
ever sent to the local proxy, which forwards it as the `Authorization` header to
`api.typesafe.ai` over HTTPS. Nothing logs it.

## How Jev plays

The full design is in [docs/jev-design.md](docs/jev-design.md). Short version:

- **The game never pauses for the network.** Physics runs at a fixed 60 Hz.
- Time is split into **24-tick windows (400 ms)**. For each window Jev picks one of six
  plans: `flap_now`, `flap_at_8`, `flap_at_16`, `no_flap`, plus `double_flap` (ticks 0 and
  12) and `triple_flap` (ticks 0, 8, 16) for fast climbs.
- **Jev sees only what a player sees.** The request state is a few sentences: whether
  you are rising or falling, whether the hole is ABOVE or BELOW you and by how much, how
  far the pipe is in seconds, what three rays from the bird touch (straight ahead, 45°
  up, 45° down) and where the next hole is. Nothing about option outcomes is sent.
- Three questions run in parallel in one request: `danger` (Noul: about to hit the bottom
  pipe or ground?), `climb` (Choice: none / one flap / two flaps / three flaps) and
  `timing` (Choice: now / soon / late for a single flap). Code composes the plan from
  `climb` and `timing`. Probabilities from every answer drive the bars in the console and
  the edge widths in the graph.
- Physics stays in code only for the LATE fallback, the trajectory overlay and the
  "code would pick" comparison shown in the console.
- **Pipelining:** as soon as a plan is committed, the client computes the exact state at
  the start of the *next* window and sends that request immediately, so Jev has the whole
  400 ms to answer. Measured round trip through the proxy is about 250–300 ms. If an
  answer is late, that window uses the physics heuristic and is labelled **LATE** in the
  console, so a fallback is never mistaken for a Jev decision.
- **No overrides.** What Jev picks is what the bird does. The console shows what a plain
  physics heuristic would have picked and the agreement rate, for comparison only.
- **No wasted calls.** Nothing is sent while the bird is dead, the game is paused, the
  tab is hidden, or an error is showing. In-flight requests are cancelled on death.
  A per-session request cap (default 3000, editable) is a hard stop.

## Cost and latency

From the TypeSafe models page at the time of writing: Jev costs **$0.042 per million
input tokens** (output free), limits are **1,200 requests/min**, and the building guide
says most requests finish in about **100 ms**. One request here is a few hundred input
tokens (about 250 with the sensor state), so a minute of play (about 150 requests) costs a fraction of a cent. The console shows
tokens and the running estimate from the `usage` field of each response.

**Why not one persistent connection?** TypeSafe exposes an HTTP request/response API
only; the docs have no WebSocket or streaming endpoint. The proxy keeps the TLS
connection alive between requests (undici keep-alive), so after the first request each
call is a single round trip. Combined with pipelining, that removes the stop-and-go
feeling without any protocol tricks.

## Tests

```powershell
npm test
```

Physics parity with the original `Bird`/`Pipe` classes, request contract, response
parsing, proxy behaviour (key precedence, validation, upstream error mapping, limits,
static-file guard) and the watch loop (stepping while pending, late fallback, stale
responses, no calls when dead/paused/hidden, pipelined state). No live calls are made.

## Docker

```sh
docker build -t flappy-jev .
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env flappy-jev
```

The image copies only application files. Static-only hosting cannot run the proxy.
