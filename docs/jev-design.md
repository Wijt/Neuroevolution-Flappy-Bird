# Flappy Jev — design spec (v2)

This document is the contract between the server, the physics/contract module and the
browser watch scene. Every module listed here must match these signatures exactly.

## Why v2 (what was wrong with the prototype)

The prototype (baseline commit `cb86928`) had these problems:

1. **Game froze on every request.** The simulation paused while waiting for Jev, then ran
   6 ticks, then paused again. That is the "interrupt" feeling. TypeSafe docs say most
   requests finish in ~100 ms and allow 1,200 requests/min, so freezing is unnecessary.
2. **Budget paranoia made it unplayable.** 1.2 s minimum spacing, 60 attempts per page
   session, 120 per key on the server, single in-flight request (`busy` flag). Jev costs
   $0.042 per *million* input tokens; one request here is ~500–800 tokens, so 1000
   requests cost about 3 cents. The user's actual concern was: **no calls while dead,
   paused or hidden**, not throttling live play.
3. **Code played the game, not Jev.** A "safety layer" overrode Jev's answer, and a
   "local coast" rule skipped Jev whenever the bird was rising. Result: Jev's choice was
   often irrelevant, and the UI could not honestly show what Jev decided.
4. **Binary flap/coast every 6 ticks is a bad question.** It forces Jev to reason about
   timing implicitly ("flap now or in 6 ticks?") from a 30-tick coast forecast. The
   right TypeSafe shape is *select instead of generate*: code enumerates concrete plans,
   simulates each one exactly, and Jev selects among described outcomes.
5. **Visuals replaced the game.** Canvas resized to 800×500 landscape, moved into a
   custom DOM "console", original colours dropped. Keep the original game look and add
   a panel beside it.
6. **Game rules changed.** Ceiling became fatal; original game has no ceiling death.
7. Nothing was committed.

## Architecture

```
browser (p5 scene, 60 Hz fixed-step physics, never blocks on network)
   │  POST /api/jev/decide  { id, state, apiKey? }
   ▼
node server.js (same-origin proxy, keep-alive to TypeSafe, key never logged)
   │  POST https://api.typesafe.ai/v1/systemone   Authorization: Bearer <key>
   ▼
Jev (one Choice question: which 24-tick plan)
```

### Real-time pipelined decision loop

- Physics runs at a fixed 60 Hz regardless of network. **The game never pauses for Jev.**
- Time is divided into **decision windows of `HORIZON = 24` ticks (400 ms)**. Measured Jev
  round trip through the proxy is 250–300 ms; a 200 ms window made almost every answer late.
- A **plan** covers one window. Single-flap plans `flap_now` (tick 0), `flap_at_8`,
  `flap_at_16` and `no_flap` handle fine positioning; `double_flap` (ticks 0, 12) and
  `triple_flap` (ticks 0, 8, 16) let the bird climb fast. One flap per 400 ms window gains
  only ~34 px, which was not enough to recover from a low position.
- **Pipelining:** the moment plan *k* is committed for window *k*, the client computes
  the exact game state at the start of window *k+1* (physics is deterministic; pipes
  scroll at constant speed) using `JevPhysics.advance(state, plan)`, and immediately sends
  the request for window *k+1*. Jev has a full 400 ms to answer.
- When window *k+1* starts: if the answer arrived, apply it. If not, use the physics
  heuristic (`bestPlan`) for that window only, mark the decision as **LATE** in the UI, and
  discard the answer when it arrives. No override of an answer that did arrive: what Jev
  picks is what the bird does.
- Window 0 has nothing to pipeline from: Start sends request 0 immediately and holds the
  first tick for at most 1.5 s until it arrives (`WatchScene.WARMUP_MS`).
- Pausing does not abort the in-flight request (already paid for); it is reused on resume.
- Request rate ≈ 2.5/s (150/min) while alive, ~1,350 input tokens per request. Configurable via `HORIZON`.
- **No requests when:** bird dead, game paused, not started, tab hidden
  (`document.hidden`), or an error is showing. On death: cancel in-flight request, show
  Game over + score, "Play again" button. Optional "Auto restart" checkbox (default off)
  restarts after 2 s.
- Optional per-session request cap (default 3000, editable number input; 0 = unlimited).
  When reached, pause and say so.

### Game rules (must match original master game)

- Constants from `data/constants.js`: `GRAVITY=0.4`, `BIRD_JUMP_POWER=6`,
  `PIPE_SCROOL=2`, `PIPE_GAP_H=125`, `PIPE_WIDTH=50`, `PIPE_BETWEEN=200`,
  `GROUND_HEIGHT=50`, `BIRD_R=25`, `BIRD_X=100`.
- Bird tick: `y += velocity; velocity += GRAVITY`. Flap: `velocity = -BIRD_JUMP_POWER`.
- Collision radius is `BIRD_R - 10 = 15` (see `circleRect` in `data/utils.js`).
- Death: circle–rect hit with a pipe, or `y + 15 >= groundY` (`groundY = height - GROUND_HEIGHT`).
  **No ceiling death** (bird may go above y=0; it just wastes height).
- Score +1 when the bird passes a pipe's centre x.
- Canvas: keep `sketch.js` sizing (portrait `windowHeight*9/16 × windowHeight`, or full
  window under 1000 px). Do **not** resize the canvas in the watch scene.

## Module contracts

All three browser modules are UMD-style: `module.exports` under Node, else a global.

### `data/jev-physics.js` → global `JevPhysics`

```js
JevPhysics.HORIZON            // 24
JevPhysics.PLANS              // Object.keys(FLAP_TICKS)
JevPhysics.FLAP_TICKS         // { flap_now:[0], flap_at_8:[8], flap_at_16:[16], double_flap:[0,12], triple_flap:[0,8,16], no_flap:[] }
JevPhysics.LOOKAHEAD          // 36  (extra ticks simulated after the window, coasting)

// GameState (plain JSON, produced by the scene, sent to the server):
// {
//   bird:    { x, y, velocity, radius }          // radius = collision radius (15)
//   world:   { width, groundY }
//   physics: { gravity, jumpPower, pipeSpeed }
//   pipes:   [{ left, right, gapTop, gapBottom }] // 1..4 pipes, sorted by left, only
//                                                 // pipes with right >= bird.x - radius
// }

JevPhysics.simulate(state, flapTicks /* number[] */, ticks /* number */)
// → { points: [{tick, y, velocity}], collision: null | { tick, with: 'top pipe'|'bottom pipe'|'ground' },
//     passedGap: boolean /* bird.x passed pipes[0].right without collision */ }

JevPhysics.forecastPlans(state)
// → { flap_now: PlanOutcome, flap_at_8: ..., flap_at_16: ..., no_flap: ... }
// PlanOutcome = {
//   flapTicks: number[],                     // ticks within the window at which the bird flaps
//   endY, endVelocity,                       // after HORIZON ticks
//   offsetFromGapCenterAtEnd,                // endY - gapCenter (positive = below centre)
//   minClearance,                            // min distance (px) between bird edge and any
//                                            // pipe/ground during HORIZON ticks, negative if hit
//   collisionWithinWindow: null | { tick, with },      // within HORIZON ticks → fatal
//   collisionIfCoastingAfter: null | { tick, with },   // HORIZON+LOOKAHEAD, no further flap
//   passesGapIfCoastingAfter: boolean,
//   trajectory: [{tick,y}]                   // HORIZON+LOOKAHEAD points, for canvas overlay
// }

JevPhysics.advance(state, plan /* plan name */)
// → GameState exactly HORIZON ticks later (bird moved with that plan, pipes shifted by
//   pipeSpeed*HORIZON, pipes whose right < bird.x - radius dropped). Pure; does not mutate.

JevPhysics.bestPlan(forecasts)
// → plan name. Deterministic heuristic used ONLY for UI comparison ("physics would pick").
//   Rule: exclude plans with collisionWithinWindow; among the rest prefer no
//   collisionIfCoastingAfter, then smallest |offsetFromGapCenterAtEnd|. If all fatal, the
//   one with latest collision tick.
```

### `data/jev-contract.js` → global `JevContract`

```js
JevContract.PLANS                  // same array as JevPhysics.PLANS
JevContract.buildRequest(state, model = 'jev-latest')
// → { model, state: <JevState>, questions: { plan: <ChoiceQuestion> } }
JevContract.parseResponse(json)    // TypeSafe response body
// → { plan, probabilities: {flap_now,...}, confidence, model, usage: {input_tokens, output_tokens} }
//   throws Error('Invalid Jev response') on any schema problem (plan not in PLANS,
//   probabilities missing/out of [0,1]/not summing to 1±0.02, confidence not in [0,1]).
```

**JevState** sent to the model is plain English, not a table. Jev is a System One model:
it judges short concrete descriptions well and must not be asked to add up ticks. Code does
all the physics; the state says where the hole is, what three rays from the bird touch, and
what each option leads to (about 300 input tokens).

```json
{
  "game": "You are the bird in Flappy Bird. Fly through the hole between the top pipe and the bottom pipe. Touching a pipe or the ground kills you.",
  "now": "You are falling. The hole is ABOVE you by 98 px. The pipe is far (about 1.5 s away). The hole after that is 140 px lower.",
  "rays": { "straight ahead": "the bottom pipe", "ahead and up": "the hole - it goes through", "ahead and down": "the ground" },
  "options": {
    "no_flap":     "Safe: far too low by 280 px, then crashes into the ground if nothing more is done.",
    "flap_now":    "Safe: too low by 64 px, then crashes into the ground if nothing more is done.",
    "flap_at_8":   "Safe: far too low by 85 px.",
    "flap_at_16":  "Safe: far too low by 157 px.",
    "double_flap": "Safe: level with the hole.",
    "triple_flap": "Safe: slightly too high."
  }
}
```

A fatal option reads `"CRASH into the top pipe."`. Offsets are bucketed: level (<10 px),
slightly (<30), plain (<80), far (>=80). Rays go straight ahead, 45 degrees up and 45
degrees down and report the first thing they touch: top pipe, bottom pipe, ground, the
hole, or the sky.

Question (`questions.plan`):

```js
{
  type: 'choice',
  instructions:
    'Pick the option that keeps you alive and gets you level with the hole. Never pick an option that says CRASH. ' +
    'If the hole is above you, pick an option that climbs; if it is below you, let yourself fall. ' +
    'Being too low is worse than being too high because you keep falling. Each option says exactly where you end up.',
  criteria: {
    no_flap: 'Do nothing and fall.',  flap_now: 'One flap right now.',  flap_at_8: 'One flap a little later.',
    flap_at_16: 'One flap late in the step.',  double_flap: 'Two flaps: climb.',  triple_flap: 'Three flaps: climb fast.'
  }
}
```

### `server.js` → `module.exports = { createServer }`

```js
createServer({
  apiKey = process.env.TYPESAFE_API_KEY,
  model = process.env.TYPESAFE_MODEL || 'jev-latest',
  fetchImpl = fetch,          // injectable for tests
  timeoutMs = 5000,
  maxInFlightPerKey = 3,      // pipelining allows a couple of overlapping requests
  maxRequestsPerMinutePerKey = 600,
  upstreamUrl = 'https://api.typesafe.ai/v1/systemone'
})
```

- `POST /api/jev/decide` body `{ id: string|number, state: GameState, apiKey?: string }`.
  Browser key (trimmed, non-empty) wins over env key. Missing both → 503
  `{ error: 'No API key. Enter one in the page or set TYPESAFE_API_KEY.' }`.
- Validate GameState shape and ranges (finite numbers, 1–4 pipes, right > left,
  gapBottom > gapTop, physics equal to game constants). Bad → 400.
- Build request with `JevContract.buildRequest`, call upstream with keep-alive
  (Node 24 `fetch`/undici already reuses connections; additionally create an
  `undici.Agent({ keepAliveTimeout: 30_000, connections: 8 })` via `require('undici')`
  guarded in try/catch and pass it as `dispatcher` when available).
- Response 200 `{ id, plan, probabilities, confidence, model, usage, latencyMs }`.
- Upstream 401 → 401 `{ error: 'TypeSafe rejected the API key.' }`.
  Upstream 429/529 → 429 `{ error, retryAfterMs }` (honour `retry-after`, default 2000).
  Other upstream errors / invalid body / timeout → 502 with a short message; never forward
  the upstream body text.
- Per-key limits keyed by sha256(key): in-flight > `maxInFlightPerKey` → 429; more than
  `maxRequestsPerMinutePerKey` in a sliding minute → 429. Nothing else throttles.
- Same-origin guard: `Host` must be localhost/127.0.0.1 and `Origin`, if present, must
  match. Static file serving of `index.html` and `data/**` only; dotfiles/`..` → 404.
  No logging of keys or request bodies.
- `if (require.main === module)` listen on `PORT || 3000`, `HOST || 127.0.0.1`.

### Browser: `data/scenes/watch-scene.js` (class `WatchScene`) + `data/jev-panel.js` (class `JevPanel`)

Replace `data/jev-dashboard.js` with `data/jev-panel.js`. The scene owns game and loop
state; the panel owns DOM.

Scene state machine: `idle` (key not entered / not started) → `running` ⇄ `paused` →
`dead`. `error` overlays running/paused (pauses, shows message + Retry).

Scene responsibilities:
- `start()`: build the panel, reset the game, register `visibilitychange` (pause on hide).
- `resetGame()`: bird at `(BIRD_X, 100)`, pipes as in the original watch scene, counters
  reset, cancel in-flight requests (AbortController + generation counter).
- `gameState()`: GameState per contract.
- `update()`: fixed-step accumulator (`performance.now()`, clamp delta ≤ 50 ms, no
  catch-up spiral). At each window start call `commitWindow()`:
  - take `pending[k]` if resolved → plan; else `no_flap` + `late++`.
  - record decision `{ index, plan, probabilities, confidence, latencyMs, late, physicsBest,
    agree }`, push to `history` (keep 50).
  - compute `nextState = JevPhysics.advance(gameState(), plan)`, send request `k+1` with
    `id = k+1` (only if running, alive, visible, under cap).
  - inside the window, at every tick in `FLAP_TICKS[plan]`, call `bird.jump()`.
- `step()`: pipes update + recycling (keep the prototype's manual recycling, it was
  correct), bird update, collision, score. On death: cancel requests, state `dead`.
- `draw()`: original look: `BG_COLOR` background, pipes via `pipe.show()`, bird via
  `bird.show()`, ground `GROUND_COLOR`, score. Add a faint overlay of the four plan
  trajectories for the current window (from `forecastPlans` at window start), chosen plan
  brighter. Draw the gap centre marker of the next pipe. On death, dim overlay + "Game over".
- Requests: `fetch('/api/jev/decide', {signal})`, 4 s client timeout, parse, validate
  (`plan` in PLANS, `id` matches). Errors: 401 → error state "API key rejected"; 429 →
  keep playing with `no_flap`, back off `retryAfterMs`, show "rate limited"; 5xx/network →
  after 3 consecutive failures enter error state, otherwise keep playing.
- `exit()`: remove listeners, abort requests, clear key field, remove panel.

Panel (`JevPanel`) is a `<aside class="jev-panel">` appended to `document.body`, placed to
the right of the canvas on wide screens, below it on narrow ones (CSS grid/flex, no
canvas resizing; the canvas is positioned by `sketch.js` — on wide screens shift it left
by half the panel width via a body class, on narrow screens stack). Sections:
1. **Session**: password input for API key (placeholder "TypeSafe API key — or set .env"),
   Start / Pause / Play again button, Menu button, Auto-restart checkbox, request cap
   input, status line (`role=status`).
2. **Jev decision**: current window plan name big, 4 horizontal probability bars
   (`flap_now, flap_at_8, flap_at_16, no_flap`) from the latest response, confidence,
   latency last / avg / p95, badge "LATE" when the window used the fallback.
3. **Physics comparison**: "physics would pick: X" and running agreement %. Display only.
4. **Usage**: requests sent, on-time %, tokens in/out (from `usage`), estimated cost
   `$ = input_tokens * 0.042 / 1e6` shown with 6 decimals, req/s.
5. **Last request / response** (collapsed `<details>`): pretty JSON of the last request
   body sent to the server (without key) and last response.
6. **History**: last 10 decisions as a compact list (`#k plan p=0.87 lat=112ms`).

Styling: reuse game palette (`BG_COLOR #1b1b2f`, `PIPE_COLOR #1f4068`, `GROUND_COLOR
#162447`, `BIRD_COLOR #e43f5a`), system font stack, high contrast, panel width ~360 px,
scrollable. No external fonts or libraries. Keep `.main-menu-button` styles unchanged.

### `index.html`

Script order: constants, utils, bird, ai-bird, pipe, perceptron, neuralnetwork, evolution,
scenesystem, main-menu-scene, play-scene, train-scene, `data/jev-physics.js`,
`data/jev-contract.js`, `data/jev-panel.js`, `data/scenes/watch-scene.js`, style.css, sketch.

### Tests (`node --test`, no dependencies)

- `test/physics.test.js`: simulate matches original Bird/Pipe math tick for tick;
  collisions with top/bottom/ground detected; `advance` equals stepping the real Bird +
  Pipe classes 24 times; `bestPlan` rules; `forecastPlans` shape.
- `test/contract.test.js`: `buildRequest` shape (question type choice, 4 criteria keys,
  no trajectories in state, numbers rounded), `parseResponse` accepts a valid answer and
  rejects bad ones.
- `test/server.test.js`: browser key over env key; missing key 503; invalid state 400;
  upstream 401/429/500/timeout mapping; in-flight limit; per-minute limit; static file
  guard; key never appears in body sent upstream; `usage` forwarded.
- `test/watch.test.js` (vm harness like the prototype): game keeps stepping while a
  request is pending; late answer → `no_flap` + `late` counted; answer for stale
  generation ignored; no requests when dead/paused/hidden; flap fires at the plan's tick;
  request for k+1 is sent at the start of window k with `advance`d state; death cancels
  in-flight; cap stops requests.

### Docs

`README.md`: run, key handling (browser field or `.env`), how the loop works (pipelining,
late fallback, no safety override), cost/rate numbers from the TypeSafe models page
($0.042 per 1M input tokens, 1,200 req/min, ~100 ms typical), why there is no WebSocket
(TypeSafe offers HTTP only; we use keep-alive + pipelining), Docker, tests.

---

# v3: pure sensor mode + judgment console

## Why

In v2 the state told Jev where every option ends up ("Safe: level with the hole"). Code had
already solved the problem; Jev only read the answer. v3 gives Jev **perception only** and
lets it judge. Physics stays in code for the LATE fallback, the canvas overlay and the
"code would pick" comparison, but **nothing about option outcomes reaches the model**.

## Request (sensor state, ~200 tokens)

```json
{
  "game": "You are the bird in Flappy Bird. Fly through the hole between the top pipe and the bottom pipe. Touching a pipe or the ground kills you. You fall all the time; a flap gives one push upward.",
  "you": "falling",
  "hole": "ABOVE you by 98 px",
  "pipe": "far (about 1.5 s away)",
  "rays": { "straight ahead": "the bottom pipe", "ahead and up": "the top pipe", "ahead and down": "the ground" },
  "next_hole": "140 px lower than this one"
}
```

- `you`: `rising` | `falling` | `level` (velocity thresholds ±0.5).
- `hole`: `ABOVE you by N px` | `BELOW you by N px` | `straight ahead at your height` (<10 px).
- `pipe`: `far (about S s away)` (>1 s) | `close (about S s away)` (>0.4 s) | `right ahead (about S s away)` | `you are inside the pipe right now`.
- `rays`: same three rays as v2 (straight, 45° up, 45° down): first thing touched.
- `next_hole`: present only when a second pipe exists: `N px lower/higher than this one` | `at the same height`.

## Questions (all in one request; they run in parallel)

```js
questions: {
  danger: { type: 'noul',
    instructions: 'Will you hit the bottom pipe or the ground within the next half second unless you flap?' },
  climb: { type: 'choice',
    instructions: 'How much height do you need to gain in the next 0.4 seconds? Choose by where the hole is and how you are moving. ' +
                  'If the hole is below you or you are rising above it, do not flap. Being too low is worse than being too high because you keep falling.',
    criteria: {
      none:        'No flap. You keep falling (or keep rising if you were rising).',
      one_flap:    'One flap. A small push: roughly holds your height over the step.',
      two_flaps:   'Two flaps. A steady climb of about 60 px.',
      three_flaps: 'Three flaps. The fastest climb, about 100 px.'
    } },
  timing: { type: 'choice',
    instructions: 'If you flap only once in the next 0.4 seconds, when should it be? Flap sooner when you are falling fast or the pipe is close; later when you have room.',
    criteria: {
      now:   'Flap immediately.',
      soon:  'Wait a moment (about 0.13 s), then flap.',
      late:  'Wait longer (about 0.27 s), then flap.'
    } }
}
```

Criteria describe **controls** (what a flap does in general), never this situation's outcome.

## Composition (code, `JevContract.composePlan(answers)`)

Policy uses Jev's whole distribution, not the argmax, and Jev's own danger judgment:

1. `flaps = round(E[flaps])` where `E = 0·p(none) + 1·p(one) + 2·p(two) + 3·p(three)`.
   A 55/34/8/2 split (argmax "none") is 0.56 expected flaps → one flap. This removes
   the bang-bang none/three oscillation seen in live play.
2. If that gives 0 flaps but `danger.noul >= 0.6`, flap once anyway.
3. 1 flap → `timing` picks `flap_now` / `flap_at_8` / `flap_at_16`; 2 → `double_flap`;
   3 → `triple_flap`; 0 → `no_flap`.

Nothing in the policy looks at physics. `answers.climb.expectedFlaps` is returned for the
console. The `you` sensor also carries speed: `falling fast` (|v| > 4), `falling`,
`falling slowly`, same for rising, or `level (not moving up or down)`.

## API changes

- `JevContract.buildRequest(state, model)` builds the sensor state and the three questions.
- `JevContract.parseResponse(json)` → `{ answers: { danger: { noul }, climb: { choice, probabilities, confidence }, timing: { choice, probabilities, confidence } }, plan, model, usage }` where `plan = composePlan(answers)`. Throws `Invalid Jev response` on schema problems.
- Server response: `{ id, plan, answers, model, usage, latencyMs }` (drop top-level `probabilities`/`confidence`).
- Scene: uses `plan` exactly as before; stores `answers` on the decision record for the console. LATE fallback and physics overlay unchanged.

## Console UI (replaces `JevPanel`; file `data/jev-console.js`, class `JevConsole`)

Look: the TypeSafe Doom demo. Near-black background (`#050a06`), phosphor green
(`#39ff8a`, dim `#1f7a45`, text `#b8ffd4`), thin 1 px green borders, monospace
(`Consolas, "SF Mono", Menlo, monospace`), uppercase small-caps section labels, no images,
no external fonts. Amber (`#ffb347`) only for LATE/fallback, red (`#ff5c5c`) for CRASH/death.

Layout (CSS grid on `body.jev-console-open`, full viewport, page scrolls if needed):

```
┌──────────────────────────────┬──────────────────────────────────┐
│  GAME (canvas, framed)        │  ORDERS   key · Start/Pause · Menu · cap · auto │
│  portrait, scaled to fit      │  DIRECTOR  req 495 · late 3% · lat 280 ms · $0.0012 │
│                               │  JUDGMENTS                        │
│                               │   DANGER  noul bar 0.82           │
│                               │   CLIMB   4 bars + conf           │
│                               │   TIMING  3 bars + conf           │
│                               │  SITUATION REPORT (sensor state as sent) │
├──────────────────────────────┴──────────────────────────────────┤
│  STATUS LINE: "GOAL: TWO FLAPS · CLIMB 0.61 · DANGER 0.82 · #17 LATE?"          │
├──────────────────────────────────────────────────────────────────┤
│  GRAPH (inline SVG, full width, ~300 px tall)                    │
│  sensors → state → questions → options → compose → plan → flaps → bird │
└──────────────────────────────────────────────────────────────────┘
```

- The p5 canvas element is moved into the GAME frame and CSS-scaled (`width:100%;
  height:auto; max-height: 100%`) without `resizeCanvas`; restored to `document.body` with
  its original inline style on `exit()`.
- JUDGMENTS: each card shows the question id in a green tag, the instructions text in dim
  green, one bar per option (chosen option bright with its label bright, others dim), the
  probability at the right, `conf 0.47` under the bars. `danger` shows a single bar for the
  yes-probability and the word YES/NO.
- GRAPH: inline SVG drawn once, updated per decision. Columns left→right: 6 sensor nodes
  (`you`, `hole`, `pipe`, `ray ↑`, `ray →`, `ray ↓`) → `state` → 3 question nodes → their
  option nodes (4 + 3 + yes/no) → `compose` → `plan` node (text = chosen plan) → 3 `flap @0 / @8 / @16`
  nodes → `bird`. Edges from a question to its options have stroke width proportional to
  probability and opacity = probability; the chosen path (state → climb → chosen option →
  compose → plan → active flap nodes → bird) glows bright; unused nodes dim. LATE windows
  draw the path amber from `compose` on. Node labels show live values (e.g. `hole: ABOVE 98`).
- Collapsible `<details>` for raw request/response JSON and a 10-entry history list.

Tests: `test/contract.test.js` (sensor state has no outcome words: assert no `Safe`,
`CRASH`, `level with`, `too low`, `too high`; composePlan table; parseResponse schema),
`test/server.test.js` (answers forwarded), `test/watch.test.js` (decision record carries
`answers`). No DOM tests for the console; it must not throw when constructed with the vm
harness's stub `document` (the scene builds it only in `start()`).
