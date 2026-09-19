# Jev Pilot Design Contract

This document is normative. Code must match it. If the two disagree, fix one of them and bump
the version.

## What this is

The `jev` scene puts TypeSafe's Jev model in the pilot chair of Flappy Bird. The game loop does
not steer the bird. Every few frames the code describes the visible scene in words, sends that
description to Jev, and flaps when Jev says to flap.

The other scenes (play, train, watch) are untouched. This is an experiment, not a replacement
for the neuroevolution brain.

## Why semantic and not numeric

Jev is a System One model. It is good at fast common sense judgements about a described
situation. It is not good at raw numbers. Sending `birdY: 437.2, gapCenter: 401.8` asks the
model to do arithmetic it is not built for.

So the translator converts numbers into a small fixed vocabulary. Each field has a handful of
phrases and nothing else. The model always sees the same words for the same kind of situation.
The vocabulary is the tuning lever. If the bird flies badly we change phrases or thresholds. We
never add a code override of Jev's decision.

## State contract

File: `data/jev/scene-translator.js`. Global `JevTranslator`, also `module.exports`.

`JevTranslator.VERSION = "1.0.0"`.

### Input

```js
{
    birdX, birdY, birdVelocity, birdRadius,     // birdRadius is 15, the collision radius
    framesSinceFlap,
    nextPipe: { x1, x2, gapCenter },
    followingPipe: { gapCenter } | null,
    groundY, canvasHeight
}
```

The translator touches no p5 globals, no DOM, and no `width` / `height`. It is a pure function.

### Output

`describeScene(input)` returns `{ state, prose, fields }`.

`state` is the object sent to the API:

```json
{
  "rules": "<RULES_TEXT>",
  "bird": {
    "vertical_motion": "...",
    "place_in_gap": "...",
    "last_flap": "...",
    "surroundings": "..."
  },
  "pipe_ahead": { "distance": "..." },
  "following_gap": "..."
}
```

The `following_gap` key is omitted entirely unless the bird is between the pipes AND
`followingPipe` is not null. An absent key is not the same as an empty string. Do not send
`null`.

`prose` is format B, the same content as one paragraph. `fields` is a flat map of the six
phrases for the side panel. In `fields` the `following_gap` entry is `null` when it does not
apply.

### RULES_TEXT

Verbatim:

> The bird flies right at constant speed and cannot slow down or turn. Gravity pulls it down
> constantly. A flap gives one short upward hop, after which it falls again; flapping repeatedly
> stacks hops upward. Pipes arrive from the right; each has a top and bottom pipe with an opening
> between them. Touching a pipe, the ground or the ceiling ends the flight.

The last sentence is true in the jev scene only. See Known deviations.

### Vocabulary and thresholds

Every bucket set is exhaustive. No input falls through.

| Field | Phrases in order | Thresholds |
|---|---|---|
| `vertical_motion` (v px/frame, negative is up) | shooting upward from a flap / still rising / hanging at the top of its hop / starting to fall / falling / dropping fast | v <= -4 / -4 < v <= -1 / -1 < v < 1 / 1 <= v < 3 / 3 <= v < 6 / v >= 6 |
| `place_in_gap` (off = birdY - gapCenter, positive is below) | level with the top pipe / close to the top pipe edge / a little above the middle / in the middle of the gap / a little below the middle / close to the bottom pipe edge / level with the bottom pipe | off < -50 / -50 to -35 / -35 to -15 / abs(off) <= 15 / 15 to 35 / 35 to 50 / off > 50 |
| `last_flap` (frames since last flap) | flapped just now / flapped a moment ago / has not flapped recently | < 6 / 6 to 20 / > 20 |
| `surroundings` | the ground is close below / the ceiling is close above / open sky above and below | groundY - (birdY + r) < 60, checked first / birdY - r < 60 / otherwise |
| `pipe_ahead.distance` (d = x1 - (birdX + r)) | between the pipes right now / right in front of the bird / close ahead / some distance ahead / far ahead | x1 <= birdX <= x2 / d < 40 / 40 to 100 / 100 to 200 / d >= 200 |
| `following_gap` (delta = followingCenter - currentCenter) | much higher / a little higher / about the same height / a little lower / much lower | delta < -60 / -60 to -20 / abs(delta) <= 20 / 20 to 60 / delta > 60 |

Screen y grows downward. A negative `delta` means the next gap sits higher on the screen. The
sign inversion is commented in the code.

The middle band wins on ties. `abs(off) <= 15` is checked before the neighbouring bands, and
`abs(delta) <= 20` likewise. On the outer edges the wider band wins: off = -50 is "close to the
top pipe edge", off = 50 is "close to the bottom pipe edge", delta = -60 is "a little higher",
delta = 60 is "a little lower".

The bucket helpers are exported individually for the calibration harness:
`verticalMotion(v)`, `placeInGap(offset)`, `lastFlap(frames)`,
`surroundings({birdY, birdRadius, groundY})`, `pipeDistance({birdX, birdRadius, x1, x2})`,
`followingGap(delta)`.

### Prose template

```
<RULES_TEXT> Right now the bird is {vertical_motion}, it is {place_in_gap}, it {last_flap},
and {surroundings}. The next pipe is {distance}.[ The gap after this one is {following_gap}.]
```

### Example state

Input `{ birdX: 100, birdY: 440, birdVelocity: 5, birdRadius: 15, framesSinceFlap: 30,
nextPipe: { x1: 90, x2: 140, gapCenter: 400 }, followingPipe: { gapCenter: 280 },
groundY: 750, canvasHeight: 800 }` gives:

```json
{
  "rules": "The bird flies right at constant speed and cannot slow down or turn. Gravity pulls it down constantly. A flap gives one short upward hop, after which it falls again; flapping repeatedly stacks hops upward. Pipes arrive from the right; each has a top and bottom pipe with an opening between them. Touching a pipe, the ground or the ceiling ends the flight.",
  "bird": {
    "vertical_motion": "falling",
    "place_in_gap": "close to the bottom pipe edge",
    "last_flap": "has not flapped recently",
    "surroundings": "open sky above and below"
  },
  "pipe_ahead": { "distance": "between the pipes right now" },
  "following_gap": "much higher"
}
```

## Questions

File: `data/jev/jev-questions.js`. Global `JevQuestions`, also `module.exports`.
`JevQuestions.FLAP_THRESHOLD = 0.5`. `JevQuestions.IDS = ["flap", "read", "danger"]`.
`JevQuestions.build()` returns a fresh deep copy on every call.

```js
{
    flap: {
        type: "noul",
        instructions: "Given the described situation, should the bird flap right now?",
        criteria: {
            true: "flapping now leads to a safer position in the gap",
            false: "waiting is safer, or flapping risks the top pipe or the ceiling"
        }
    },
    read: {
        type: "choice",
        instructions: "Which best describes the bird's situation?",
        criteria: {
            too_high: "the bird sits above the opening and should come down",
            aligned: "the bird is lined up with the opening",
            too_low: "the bird sits below the opening and should climb",
            entering_pipe_misaligned: "the bird is at the pipes but not lined up with the opening",
            ground_danger: "the ground is close below and the bird is about to hit it",
            ceiling_danger: "the ceiling is close above and the bird is about to hit it"
        }
    },
    danger: {
        type: "score",
        instructions: "How close is the bird to losing?",
        criteria: [
            "comfortably safe",
            "needs a correction soon",
            "one wrong move from a collision",
            "collision nearly unavoidable"
        ]
    }
}
```

Fields read from the response: `answers.flap.noul`,
`answers.read.{choice, probabilities, confidence}`, `answers.danger.{score, legend}`,
`usage.{input_tokens, output_tokens}`.

## Decision rule

The bird flaps when `answers.flap.noul >= JevQuestions.FLAP_THRESHOLD` (0.5).

There is no code override. The game does not flap on its own when it thinks Jev is wrong. It
does not block a flap it thinks is unsafe. It does not add a safety net near the ground or the
ceiling. `read` and `danger` are shown in the panel and never touch the controls. If the bird
flies badly, the fix is the vocabulary, the thresholds, or the question criteria. Never a rule
in the game loop.

`doFlap()` is the only caller of `bird.jump()`.

## Freshness

Answers arrive later than the state they describe. Up to two requests are in flight at once, so
an answer can be stale.

Every request carries a tag `{ runId, flapSeq, frame }`. `runId` changes on every restart.
`flapSeq` increments on every flap. On arrival an answer is discarded when `tag.runId` does not
match the current run, or when `tag.flapSeq` does not match the current flap sequence. A
discarded answer bumps `stats.discarded` and nothing else.

The reason: once the bird has flapped, the described situation no longer exists. Acting on an
answer about the pre-flap state stacks unwanted hops.

## Request loop

- Cadence: one attempt every 9 frames, so about 6 to 7 attempts per second at 60 fps.
- Maximum 2 requests in flight. `client.canSend()` is false above that.
- Gates, all required before sending: the bird is alive, the jev scene is the active scene,
  `document.visibilityState === "visible"`, a description exists, and 9 frames have passed
  since the last actual send. `lastTickFrame` is updated only when a request really goes out.
- On death the client aborts all in-flight requests on the first dead frame. No requests are
  sent while dead.
- Backoff on any error: 1 s, then 2 s, 4 s, 8 s, capped at 8 s. A successful response resets it.
- Timeout: 4 s in the browser client, 8 s on the server proxy.

Budget: about 400 requests per minute at full speed, against a 1200 per minute limit. Each
request is roughly 300 input tokens. At $0.042 per million input tokens that is roughly $0.30
per hour of continuous play. The gates matter. A hidden tab, a menu, or a dead bird must cost
nothing.

## Transport and key handling

```
browser  ->  POST /api/jev  (same origin, no key)
server   ->  https://api.typesafe.ai/v1/systemone
             Authorization: Bearer <TYPESAFE_API_KEY>
             body: { state, model: "jev-latest", questions }
```

The API key never reaches the browser. The server reads it from `TYPESAFE_API_KEY` in a
git-ignored `.env`. The server forwards only `state`, a fixed `model`, and `questions`. Any
`model` field in the browser body is ignored. The server validates that `state` is an object and
that `questions` is an object with 1 to 8 entries, each with a `type` of `noul`, `choice`, or
`score` and an `instructions` string.

Upstream error bodies are logged server-side, truncated, and never echoed to the browser. The
browser sees `{ error: "upstream_error", status }`, 504 on timeout, 502 on network failure.

In Docker the key is passed at run time: `docker run -e TYPESAFE_API_KEY=... -p 3000:3000 ...`.
It is never baked into the image. `.env` is in `.dockerignore` and `.gitignore`.

## Calibration

Run the offline harness before wiring the game loop:

```
npm run calibrate
```

It requires the two shared files directly, which also proves the dual export works. It runs 25
hand-written scenes through both formats. Format A sends the `state` object. Format B sends
`{ rules, situation: prose }`.

Reading the table: each row is one case with the flap probability, the resulting action, and
PASS or FAIL for each format. The summary gives the pass count per format, the mean margin
`abs(p - 0.5)`, the failure list, token totals, mean and p95 latency, and the recommended
format. Failures print the exact state plus the `read` and `danger` answers, so you can see what
the model understood.

Pass bar: the best format must reach at least 22 of 25, and cases 6, 7, 24, 25 must pass. Those
four are the ground danger, ceiling danger, and the two following-gap sign tests. A sign error
there means the vocabulary is lying to the model.

Exit codes: 0 pass, 1 below the bar, 2 transport or configuration failure. Do not wire the game
until it exits 0. On a 1, adjust the vocabulary or the question criteria in the shared files,
bump `JevTranslator.VERSION`, note the change here, and re-run.

Chosen format: TBD after calibration.

## Known deviations

- **Ceiling death.** In the jev scene the bird dies when `bird.pos.y - JEV_COLLISION_R <= 0`.
  The play and watch scenes let the bird bump the ceiling and live. The jev scene matches the
  train scene instead, because RULES_TEXT tells Jev the ceiling ends the flight. The rules text
  must be true or the model is being misled.
- **Collision radius.** `BIRD_R` is 25. `circleRect()` in `data/utils.js` collides at
  `bird.radius - 10`, which is 15, while the debug overlay draws an ellipse of diameter
  `radius - 10`, which reads as a 12.5 radius. The translator uses 15, the real collision
  radius, via `JEV_COLLISION_R = BIRD_R - 10` in `data/constants.js`. If the collision maths
  ever changes, `JEV_COLLISION_R` must change with it.
- **Latency.** Nine frames between describing and acting is 40 to 60 px of bird movement. This
  is part of the experiment, not a bug to paper over.

## Versioning

`JevTranslator.VERSION` covers the vocabulary, the thresholds, RULES_TEXT, the state shape, and
the prose template. Bump the patch number for wording that does not move a boundary. Bump the
minor number when a threshold moves or a phrase changes meaning. Bump the major number when the
state shape or the question set changes.

Every bump means the previous calibration run is void. Re-run `npm run calibrate` and update the
chosen format line above.
