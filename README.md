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
- Time is split into **12-tick windows (200 ms)**. For each window Jev picks one of four
  plans: `flap_now`, `flap_at_4`, `flap_at_8`, `no_flap`.
- Code simulates every plan exactly and puts the outcomes in the request state (end
  position relative to the gap centre, minimum clearance, collision within the window,
  what happens if the bird keeps coasting). Jev answers one **Choice** question; its
  `probabilities` drive the bars in the panel. This is the "select, don't generate"
  pattern from the TypeSafe docs.
- **Pipelining:** as soon as a plan is committed, the client computes the exact state at
  the start of the *next* window and sends that request immediately, so Jev has the whole
  200 ms to answer. Late answers fall back to `no_flap` and are counted as *late* in the
  panel.
- **No overrides.** What Jev picks is what the bird does. The panel shows what a plain
  physics heuristic would have picked and the agreement rate, for comparison only.
- **No wasted calls.** Nothing is sent while the bird is dead, the game is paused, the
  tab is hidden, or an error is showing. In-flight requests are cancelled on death.
  A per-session request cap (default 3000, editable) is a hard stop.

## Cost and latency

From the TypeSafe models page at the time of writing: Jev costs **$0.042 per million
input tokens** (output free), limits are **1,200 requests/min**, and the building guide
says most requests finish in about **100 ms**. One request here is roughly 600–900 input
tokens, so a minute of play (about 300 requests) costs well under a cent. The panel shows
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
