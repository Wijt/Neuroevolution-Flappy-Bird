# Jev Pilot Design Contract, v2

This document is normative. Code must match it. If the two disagree, fix one of them and bump
the version.

Current contract version: `JevTranslator.VERSION = "2.2.0"`.

## 1. What this is

This is a demonstration of one pattern: structured state in, typed decision out.

Jev flies the bird in Flappy Bird. Every tick the code builds a small text snapshot of the
scene and asks Jev one question. Jev answers `FLAP` or `WAIT`. The game executes that answer
and nothing else. Code owns the physics, the perception, the latency compensation and the
execution. The model owns the judgement.

Flappy Bird does not need a model. The optimal policy is two lines:

```js
if (bird.y > gapCenter) bird.jump();
```

That is the point. The game is a fixed, measurable, real-time environment with a known correct
answer, so any failure is visible immediately. What this project shows is narrower than "AI
plays games": a System One model can pilot a real-time loop from words alone, at about 8
decisions per second, once latency is handled properly. No more than that.

The other scenes (play, train, watch) are untouched. This is an experiment, not a replacement
for the neuroevolution brain.

## 2. The v2 contract

File: `data/jev/scene-translator.js`. Global `JevTranslator`, also `module.exports`. Pure: no
p5 globals, no DOM, no `width` / `height`. Node can require it.

### Snapshot

`describeScene(input, leadFrames, dt)` returns `{ state, fields, predicted }`, or `null` when
no pipe is ahead. `state` is what goes to the API. It describes the world as it will be when
the answer arrives, with the bird left alone. See section 3.

```json
{
  "bird_position": "below the gap",
  "bird_motion": "falling fast",
  "room_above_bird_px": 102,
  "room_below_bird_px": -7,
  "next_pipe_distance_px": 123
}
```

Every field, and what it means:

| Field | Type | Meaning |
| --- | --- | --- |
| `bird_position` | phrase | where the bird sits relative to the gap |
| `bird_motion` | phrase | what the bird is doing vertically |
| `room_above_bird_px` | number | px from the bird's top edge down to the gap top, negative means the bird is higher than the gap |
| `room_below_bird_px` | number | px from the bird's bottom edge up to the gap bottom, negative means the bird is lower than the gap |
| `next_pipe_distance_px` | number | px from the bird's front edge to the pipe's leading edge, clamped at 0 |

This is the v2.2 shape. v2.0 also sent the bird's y and velocity, the gap's two screen
coordinates and an axis note; they duplicated the two clearances, cost tokens, and dropping
them raised the calibration margin (section 10c).

The pipe chosen is the first one whose trailing edge is still ahead of the bird's back edge,
after the predicted scroll. Same criterion the scenes use for scoring.

### Vocabulary and thresholds

Two phrase fields. Both are exhaustive, no input falls through.

`motion(v)`, where `v` is px per game frame and negative is up:

| Phrase | Condition |
| --- | --- |
| `rising` | `v < -1` |
| `level` | `-1 <= v <= 1` |
| `falling` | `1 < v <= 4` |
| `falling fast` | `v > 4` |

`position(above, below)`, computed from the two clearances only:

| Phrase | Condition |
| --- | --- |
| `above the gap` | `above < 0` |
| `below the gap` | `below < 0` |
| `inside the gap, upper half` | `above < below` |
| `inside the gap, lower half` | otherwise |

The centre line counts as the lower half, because `above < below` is strict. That is
deliberate, and calibration case 24 checks it.

### The question

File: `data/jev/jev-questions.js`. Global `JevQuestions`, also `module.exports`.
`JevQuestions.IDS = ["decision"]`. `build()` returns a fresh deep copy every call.

One question, one `choice`, two options.

```js
decision: {
    type: "choice",
    instructions: "What should the bird do right now to pass safely through the gap of the next pipe?",
    criteria: {
        FLAP: "the bird is below the gap, or is in the lower half of the gap and not rising",
        WAIT: "the bird is above the gap (even when falling fast), or is in the upper half of the gap, or is rising inside the gap"
    }
}
```

The option text uses the same words as `position` and `motion` on purpose. "below the gap",
"lower half", "upper half", "above the gap" and "rising" all appear in both places. Jev matches
words instead of doing arithmetic. This is the single largest lesson from v1.

The response fields read are `answers.decision.{choice, probabilities, confidence}` and
`usage.{input_tokens, output_tokens}`.

There is no code override. The game never flaps on its own, never blocks a flap, and has no
safety net near the ground or the ceiling. If the bird flies badly, the fix is the thresholds,
the phrases or the criteria. Never a rule in the game loop.

## 3. Latency compensation

The round trip is 370 to 390 ms on average. At 60 fps that is 22 to 23 draw frames. An answer
about "now" is about a world that no longer exists by the time it lands.

So the code predicts. `describeScene(input, leadFrames, dt)` runs the physics forward by
`leadFrames` draw frames with the bird left alone: gravity applies, the pipes scroll, no flap
happens. That predicted world is what Jev is asked about.

```
lead_ms    = EMA of measured latency, alpha 0.3, starting at 400 ms
leadFrames = round(lead_ms / 16.67)
```

The EMA updates on every answer that arrives. It starts at 400 ms so the first few requests are
close enough, and it tracks the real connection from there.

### Why this is not "code deciding"

The prediction contains no judgement. It answers "where will the world be", which is
arithmetic. It does not answer "what should the bird do", which is the decision. The bird is
left alone in the prediction precisely so that the prediction is not a plan.

A robot acting on a 300 ms old camera frame does the same thing. It estimates where the object
will be when the arm gets there and acts on that estimate. Nobody calls that the controller
deciding for the policy.

### Credit

This pattern is taken from the community project
[github.com/hosseintoussi/jev-flappy-bird](https://github.com/hosseintoussi/jev-flappy-bird),
which flew "for minutes without dying" with it. v1 of this project spent five versions tuning
vocabulary and never solved the timing. Prediction solved it in one step.

## 4. The loop

### Sending

- Cadence is wall clock: one request every `JEV_TICK_MS`, 100 ms in the game and 120 ms in the
  sims. Not frame based.
- Up to 8 requests in flight at once.
- The loop never waits. Frames keep running while requests are out.
- Gates before a send: the bird is alive, the jev scene is active,
  `document.visibilityState === "visible"`, and a description exists.

Every request carries a tag:

| Field | Purpose |
| --- | --- |
| `runId` | changes on every restart |
| `reqId` | pairs a `send` with its `recv` |
| `flapSeq` | how many flaps had happened when the question was asked |
| `sentFrame` | the frame the question was asked on |
| `targetFrame` | `sentFrame + leadFrames`, the frame the answer is about |

### On arrival

| Outcome | When |
| --- | --- |
| `discarded` | `tag.runId` is not the current run |
| `superseded` | `tag.flapSeq` is not the current `flapSeq`, that is, a flap happened after the question was asked |
| `held` | otherwise, parked until `targetFrame` |

A flap changes the world the question was asked about, so every answer in flight from before it
is void. That is what `flapSeq` is for.

### Each frame

Held answers whose `targetFrame` has arrived are applied, oldest first.

- `FLAP` calls `bird.jump()`, bumps `flapSeq`, and supersedes the remaining held answers.
- `WAIT` does nothing.
- An answer more than 6 frames past its `targetFrame` is dropped as `stale`.

`doFlap()` is the only caller of `bird.jump()`.

### Warm start

`start()` describes the opening scene, sends one request, and holds the world still: bird
hovering, no gravity, no scroll, frame counter at 0. The flight begins on the first answer. The
bird free-falls to the ground in about 46 frames at normal speed, which is less than one cold
request, so without this every flight died before its first answer.

### Death

Death waits for a click. Nothing is sent while dead or while the tab is hidden. An auto-restart
would spend credits on a loop nobody is watching. `runId` changes on the click, so answers from
the dead flight are discarded.

### The structural ceiling

A flap supersedes everything in flight. The next usable answer is therefore one latency away.
So the flap rate is capped at roughly one flap per lead, about 2.5 flaps per second at 390 ms,
no matter how often questions are sent.

That is why game speed still matters at our latency. Sending faster does not raise the ceiling.
Only lower latency or slower game time does.

## 5. Time scale

`JEV_TIME_SCALE = 4` is shipped. `JEV_DT = 1 / JEV_TIME_SCALE`.

- `JevBird` and `JevPipe` are the ordinary `Bird` and `Pipe` with their `update()` stepped by
  `dt`. Every other scene keeps its full step.
- The cadence and the lead stay on the wall clock, because that is where latency lives.
- Nothing Jev sees knows about the time scale. Same snapshot, same question, same version.
- Drawing is unchanged. 60 fps, same canvas. It reads as slow motion, not as a slow game.

### Measured results

All real Jev, seeds 1 to 4, 90 s budget, 120 ms tick.

| Time scale | Scores | Notes |
| --- | --- | --- |
| 1 | 1, 1 | died at 5 to 7 s; first time normal speed passed a pipe at all |
| 2 | 1, 9, 0, 4 | |
| 3 | 4, 9, 1 | |
| 4 | 4, 3, 9, 9 | the two 9s survived the full 90 s budget |

Scale 1 passing a pipe is the headline. v1 never did at normal speed, on any seed, in any
version.

### Measured cost and timing

| Metric | Value |
| --- | --- |
| Latency mean | 370 to 390 ms |
| Latency p95 | 530 to 670 ms |
| Model time (`x-envoy-upstream-service-time`) | 100 to 105 ms mean |
| Applied lateness | about 1 frame mean |
| Superseded | 20 to 35 percent of answers |
| Input tokens | about 490 per request |
| Request rate | about 8 per second while flying |
| Cost | roughly $0.60 per hour at $0.042 per million input tokens |

Model time is about a quarter of the round trip. The rest is distance.

## 6. Where the latency goes

Measured from this machine on Sep 20 2026. The API host resolves into AWS Oregon.

| Stage | Measured | Meaning |
| --- | --- | --- |
| TCP connect | 235 ms | one round trip, Turkey to the US west coast |
| TLS handshake | +250 ms | a second round trip, cold connections only |
| Warm request | 305 to 345 ms | one round trip plus 100 ms of model time |
| Cold request | 750 to 1030 ms | DNS + TCP + TLS + request |

Three quarters of an answer is distance and a quarter is Jev.

The API offers one HTTP POST endpoint and nothing else. There is no websocket and no regional
endpoint. A websocket would not help anyway, because a warm HTTP connection already costs
exactly one round trip. Moving the proxy to the USA would not help either, because the browser
stays here and the loop is browser to proxy to API and back.

### Keep-alive

Node drops idle upstream sockets after 4 seconds, so every flight that started after a pause
paid the cold price. `server/server.js` installs an undici `Agent` with a 60 s
`keepAliveTimeout`, a 10 minute max and 4 connections. Measured after the fix: 337 ms following
10 s idle, 396 ms following 25 s idle. Both would have been about 900 ms before. The first
request after a long idle is still cold, and the warm start covers it.

### Transport

```
browser  ->  POST /api/jev  (same origin, no key)
server   ->  https://api.typesafe.ai/v1/systemone
             Authorization: Bearer <TYPESAFE_API_KEY>
             body: { state, model: "jev-latest", questions }
```

The key never reaches the browser. The server reads it from `TYPESAFE_API_KEY` in a git-ignored
`.env`, forwards only `state`, a fixed `model` and `questions`, and ignores any `model` in the
browser body. It validates that `state` is an object and that `questions` has 1 to 8 entries,
each with a type of `noul`, `choice` or `score` and an `instructions` string. Upstream error
bodies are logged server side, truncated, and never echoed. The browser sees
`{ error: "upstream_error", status }`, 504 on timeout, 502 on network failure. Timeouts are 4 s
in the browser client and 8 s on the proxy.

In Docker the key is passed at run time. It is never baked into the image.

## 7. Calibration

`harness/calibrate.js`, v2. Run it with `npm run calibrate`. It requires the two shared files
directly, which also proves the dual export works.

- 24 hand-written scenes. One pipe with a 125 px gap centred at y 450, bird at x 100, collision
  radius 15, ground at 850.
- Expectations follow the criteria literally. FLAP means below the gap, or lower half and not
  rising. WAIT means everything else. No human judgement enters the expectation.
- Pass bar: 22 of 24. Exit 0 pass, 1 below the bar, 2 transport or configuration failure.
- `--dry-run` prints every snapshot without sending. `--repeat=N` averages probabilities.
  `--lead=F` calibrates a predicted scene instead of the present one.
- Margin reported is `p(expected) - 0.5`, averaged over the 24 cases.

### Result

| Run | Passes | Mean margin |
| --- | --- | --- |
| first | 23 / 24 | |
| after fixing the centre-line case | 24 / 24 | 0.34 |

The one failure was a scene sitting exactly on the gap's centre line, where the two clearances
are equal. The case and the translator disagreed about which half that is. The contract settles
it: `above < below` is strict, so the exact centre is the lower half, and the case was
rewritten to match. The model was not at fault.

### Low confidence cases

| Case | p(FLAP) | Why it is borderline |
| --- | --- | --- |
| lower half, level | 0.52 | "level" is the boundary between rising and falling, and the criterion says "not rising" |
| above the gap, pipe right there | 0.46 | above the gap says WAIT, a pipe 5 px away says do something |

Both are borderline by construction. They sit on the thresholds on purpose, so a drift in the
model's reading shows up here first.

## 8. Prior art

| Project | What it does |
| --- | --- |
| [hosseintoussi/jev-flappy-bird](https://github.com/hosseintoussi/jev-flappy-bird) | 20 questions/s, about 6 in flight, predicted snapshot, FLAP/WAIT, superseding, HTTP/2 keep-alive. Minutes without dying at 4.6x speed. The source of the v2 design. |
| [tetsuya-dev-jp/jev-pacman](https://github.com/tetsuya-dev-jp/jev-pacman) | Asks only at junctions, holds the answer until it is needed, drops late answers. The same idea, event driven instead of tick driven. |
| TypeSafe's Doom demo | 10 decisions/s on structured text, about $7 per hour. |

General LLM agents on games:

- VideoGameBench reports 3 to 5 s inference per step on screenshots, and ships a Lite mode that
  pauses the game while the model thinks.
- GameWorld has a real-time variant. Models fail on timing games there, Flappy Bird among them.

The conclusion is consistent across all of these. Real-time play works only with small fast
models on structured text. Screenshot LLM agents pause the game.

## 9. HUD and debug keys

There is no side panel. Everything Jev sees and decides is drawn on the game canvas in p5
(`data/jev/jev-hud.js`), mobile first: sizes scale with the canvas width, 11 px minimum at
375 px, the return button corner stays clear.

What is drawn, top to bottom:

- **Ticker** under the score: latency, lead in frames, requests per second, cost per hour
  at $0.042 per million input tokens, speed.
- **Timeline** of the last 300 draw frames (5 s): each request a bar from send to receive,
  green applied, amber superseded, red stale, grey in flight; flap ticks under it; a death
  line; the three counters at the right.
- **What Jev sees**, drawn as an interpretation and not as game art: an outlined ghost bird
  at the described predicted position with "+Nf" for the lead, a dashed thread from the real
  bird, the described pipe's gap halves tinted cool above and warm below, the two clearances
  in px, the distance ruler, the two words Jev matches on, and beside them the decision word
  with its probability, FLAP warm, WAIT cool, as the largest HUD text.
- **Decision flow** on the ground band: Snapshot, Question, Jev, Action with packets that
  travel for the measured latency and land with the answer; the Action box shows the two
  probability bars; an applied FLAP flashes the arrow to the game.

Style rules, borrowed from agent-view overlays elsewhere (AlphaStar's agent view, MarI/O's
input box, Tesla's "mind of car", F1 telemetry): thin outlines and low-alpha tints so the
layer reads as the model's view of the world, the decision drawn where the situation is,
four HUD colours only (BIRD_COLOR, #4f8a8b, #ffb020, #3ddc84) plus white at low alpha, no
gradients or glows, motion only where it is real.

| Input | Effect |
| --- | --- |
| tap or click while flying | cycle HUD level: full, minimal (ghost and decision only), off |
| tap or click while dead | fly again |
| H | cycle HUD level |
| P | pause and resume |
| N | one frame while paused |
| M | run to the next event while paused |
| D | download the trace as JSONL |

Trace records: header, send, recv (with outcome), apply (with lateBy), superseded (with the
asked and current words), stale, flap, death. Same format as the simulator writes.

## 10. History (v1)

v1 asked a `noul` question, "should the bird flap right now", once per tick. It could not
climb: every flap discarded the answers in flight, so the bird could produce at most one flap
per latency window. It held altitude and never rose.

The path out of that was a maneuver question with a hop plan (v1.1 to v1.5), then slowing game
time, then v2.

### v1 calibration log, condensed

25 cases, expectations written as arrays of acceptable maneuvers.

| Version | Change | Result |
| --- | --- | --- |
| 1.0.0 | noul flap question | 23/25, margin about 0.15, latency 367 ms mean |
| 1.1.0 | maneuver question, first wording | 16/25, margin 0.21. Nine failures all the same shape: above the gap, Jev picking a hop |
| 1.1.0 | criteria reworded to lead with direction | 22/25, margin 0.55 |
| 1.2.0 | phrases made bird-relative | 23/25, margin 0.72 |
| 1.3.1 | hop physics stated in the rules text | 24/25, margin 0.88 |
| 1.4.0 | depth below the gap measured in hop units | 25/25, margin 0.95 |
| 1.5.0 | pipe-crossing sentence, pipe-entry clause | 25/25, margin 0.91 |

### v1 flight log, condensed

| Mode | Result |
| --- | --- |
| Real time, v1.2.0, no warm start | dead on the ground at frame 46, zero answers received |
| Real time, v1.3.1, warm start | still dead at frame 46. Latency 490 to 650 ms, 30 to 40 frames |
| Lockstep, v1.3.1, tick 5 | scores 7 and 8. Jev flies when the world waits for it |
| Slow time, scale 4, v1.4.0 | scores 2 and 1, 27 to 29 s |
| Slow time, scale 6, v1.4.0 | scores 2 and 3, 55 to 68 s |
| Slow time, scale 4, v1.5.0 | scores 3, 0 and 4, 19 to 52 s |

### Lessons carried into v2

- Jev is bad with raw numbers unless the words mirror the options. Numbers next to matching
  words work. Numbers alone do not.
- A hop from the centre of the gap reaches the top pipe. A hop rises about 46 to 48 px and the
  safe band above the centre is 47 px. Any vocabulary that ignores this kills the bird.
- Option descriptions must lead with their direction. When they did not, Jev picked the option
  that sounded safest and never descended.
- Latency, not vocabulary, was the killer. v1.4.0 already scored 25/25 offline and still could
  not fly at normal speed. Five versions of wording did not fix what one prediction step did.

## 10b. v2.1: freshness by premise, and the horizon A/B

v2 superseded every answer in flight whenever a flap landed, which capped the flap rate at
one per round trip and made long climbs impossible. A browser flight died exactly that way
between a low gap and a high one. v2.1 changes two things.

**Freshness by premise.** Each answer is applied only if the position and motion words it
was asked about still hold at its target frame (`JevTranslator.premiseHolds`). Above and
below the gap do not depend on motion in the criteria, the two halves do. A flap no longer
clears the held list. Stub run: stale answers fell from 8.6 percent of requests to 0.1
percent, about 1.5 applied answers per request, a 12-flap climb in 35 frames.

**Two horizons per request (tested, removed).** For the A/B, each request carried a `now`
and a `later` snapshot side by side with one question per snapshot, each told which key to
judge. Calibration in that form: 24/24, margin 0.40, so Jev reads a named snapshot and
ignores its neighbour, which is useful to know for fan-out designs in general. The simulator A/B against real Jev
at 1/4 speed, three seeds, 90 s each:

| | two horizons | single |
| --- | --- | --- |
| score | 9, 9, 9 (all survived) | 9, 9, 9 (all survived) |
| longest climb, px | 444, 222, 427 | 431, 265, 434 |
| stale candidates | 204 | 47 |
| applied lateness | 0.55 frames | 1.05 frames |
| tokens per request | about 760 | about 490 |

The second horizon lands answers half a frame closer to their moment and the outcome does
not care. The mechanism was removed from the code rather than kept as a knob; commit
3312c4d holds the two-horizon version if it is ever wanted again.

## 10c. v2.2: token cost

Measured on the same three seeds at 1/4 speed, 90 s budget, real Jev. Baseline was the v2.1
snapshot at a 100 ms tick: 489 input tokens per request, 268k tokens per minute of flight,
about 1M tokens per 20 pipes.

| change | tokens / request | tokens / minute | result |
| --- | --- | --- | --- |
| compact snapshot (words + three numbers, no coordinates, no axis note) | 420 | 230k | 24/24 calibration, margin 0.46 (up from 0.34) |
| compact + tick 150 ms | 420 | 161k | 9, 9, 9 |
| compact + tick 200 ms | 420 | 124k | 9, 9, 9 |
| compact + tick 250 ms | 420 | 97k | 9, 9, 9 |
| compact + tick 300 ms | 420 | 81k | 9, 9, 9 |
| compact + tick 150 + skip re-asking while the words are unchanged (400 ms) | 418 | 89k | 3, 9, 1 and 2, 9, 9: rejected |

Two lessons. The question and its criteria are about 350 of the 420 tokens, so shrinking
the snapshot saves little; the request rate is the lever. And "do not re-ask an unchanged
situation" kills: when the words stay "below the gap, rising" the pilot must keep flapping,
and skipping the question means no new answer to apply. Jev has to be asked at the cadence
the flaps need.

Shipped: compact snapshot (the only shape now, translator 2.2.0) and `JEV_TICK_MS = 250`,
about 4 requests per second, roughly 97k tokens per minute of flight, about 390k tokens
(1.6 cents) per 20 pipes. 300 ms also passed and is the next knob if cost matters more
than margin against latency spikes.

## 11. Versioning

`JevTranslator.VERSION` covers the thresholds, the phrases, the state shape and the question
set.

| Bump | When |
| --- | --- |
| patch | wording that does not move a boundary |
| minor | a threshold moves or a phrase changes meaning |
| major | the state shape or the question set changes |

2.0.0 is a major bump on both counts: a new state shape (numbers plus two phrase fields, no
rules text) and a new question set (one binary `decision` instead of three questions).

Any change to a phrase or a criterion voids the current calibration. Re-run `npm run calibrate`
and the simulator, and add a row to the tables above.

## Known deviations

- **Ceiling death.** In the jev scene the bird dies when `bird.pos.y - JEV_COLLISION_R <= 0`.
  The play and watch scenes let the bird bump the ceiling and live. The jev scene matches the
  train scene.
- **Collision radius.** `BIRD_R` is 25 but `circleRect()` collides at `bird.radius - 10`, which
  is 15. The translator uses 15, via `JEV_COLLISION_R = BIRD_R - 10`. If the collision maths
  changes, `JEV_COLLISION_R` must change with it.
- **The bird still acts on a prediction.** When the prediction is wrong, because a flap landed
  between the question and the answer, the answer is superseded rather than corrected. 20 to 35
  percent of answers are thrown away this way. That is the cost of the design, not a bug in it.
- **No restart while dead.** The bird waits for a click. That is a cost decision.
