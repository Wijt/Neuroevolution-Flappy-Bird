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
- Time is split into **24-tick windows (400 ms)**. In each window the bird can flap at
  tick 0, at tick 12, both, or not at all.
- **Jev sees only what a player sees.** The request state is a few sentences: rising or
  falling, whether the hole is ABOVE or BELOW you and by how much (with both edges), how
  far the pipe is in seconds, what three rays from the bird touch (straight ahead, 45° up,
  45° down; they are drawn on the canvas) and where the next hole is.
- **Three yes/no questions, one threshold.** In one request Jev answers `flap_now`
  ("Should you flap right now?"), `flap_again` ("Suppose you flap now; flap again 0.2 s
  later?") and `flap_later` ("Suppose you do not flap now; flap 0.2 s later instead?").
  Each comes back as a probability. Code applies a single threshold (console input,
  default 0.5): now ≥ T and again ≥ T → two flaps; now ≥ T → one flap now; later ≥ T →
  one flap at 0.2 s; otherwise nothing. No means, medians or hidden rules.
- The console shows the three probabilities against the threshold, and the graph shows
  which YES/NO edges were taken. Question texts are editable live in the PROMPTS section.
- Physics stays in code only for the LATE fallback, the trajectory overlay and the
  "code would pick" comparison.
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
