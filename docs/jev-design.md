# Jev Pilot Design Contract

This document is normative. Code must match it. If the two disagree, fix one of them and bump
the version.

## What this is

The `jev` scene puts TypeSafe's Jev model in the pilot chair of Flappy Bird. The game loop does
not steer the bird. Every few frames the code describes the visible scene in words, sends that
description to Jev, and executes the maneuver Jev picks.

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

## Why the question is a maneuver and not a single flap

The first design asked a yes/no question once per request: should the bird flap right now? That
cannot work at the real speed of the loop.

- Measured latency on the first live run was 367 ms in the harness and about 280 ms in the
  browser. That is roughly 17 frames, not the 100 to 150 ms the earlier draft assumed.
- One flap gains about 45 px and the bird is back at the same height about 30 frames later.
  Gaining real height needs 3 to 4 flaps spaced about 8 frames apart.
- With one yes/no answer per round trip, and with answers discarded after every flap, the bird
  could produce at most one flap per latency window. It could hold altitude and never climb.

Live this showed up exactly as the arithmetic predicts. The bird sat level with the bottom pipe,
`flap` hovered around 0.57, one hop went out, the bird fell back to the same place, and it died
there over and over.

So the unit of decision is now a short plan, not a single frame. Jev picks how much to climb;
code turns that number into that many jumps. This is bounded action selection: the set of
actions is fixed and tiny, Jev chooses among them alone, and code only spaces the flaps out.

## State contract

File: `data/jev/scene-translator.js`. Global `JevTranslator`, also `module.exports`.

`JevTranslator.VERSION = "1.4.0"`.

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
  "next_opening": "..."
}
```

The `next_opening` key is omitted entirely unless the bird is between the pipes AND
`followingPipe` is not null. An absent key is not the same as an empty string. Do not send
`null`.

`prose` is format B, the same content as one paragraph. `fields` is a flat map of the six
phrases for the side panel. In `fields` the entry is still called `following_gap` and is `null`
when it does not apply. The state key is `next_opening`.

### RULES_TEXT

Verbatim:

> The bird flies right at constant speed and cannot slow down or turn. Gravity pulls it down
> constantly. A flap gives one short upward hop, after which it falls again; flapping repeatedly
> stacks hops upward. A single hop from the middle of an opening carries the bird all the way up
> into the top pipe, so the bird should only hop when it is below the middle of the opening.
> Pipes arrive from the right; each has a top and bottom pipe with an opening between them.
> Touching a pipe, the ground or the ceiling ends the flight.

The ceiling sentence is true in the jev scene only. See Known deviations.

The hop sentence is a measured fact, not a hint. A hop sets the velocity to -6 against a
gravity of 0.4, so the bird rises about 48 px before it starts falling again. The opening is
125 px tall and the collision radius is 15 px, so the safe band above the centre is 47 px. A hop
from the centre ends inside the top pipe. Jev cannot see any of those numbers, and a human
pilot learns this in the first five seconds of play, so the rules say it in words. Without it,
lockstep flights died on the first pipe every time by hopping from the middle.

### Vocabulary and thresholds

Every bucket set is exhaustive. No input falls through.

| Field | Phrases in order | Thresholds |
|---|---|---|
| `vertical_motion` (v px/frame, negative is up) | shooting upward from a flap / still rising / hanging at the top of its hop / starting to fall / falling / dropping fast | v <= -4 / -4 < v <= -1 / -1 < v < 1 / 1 <= v < 3 / 3 <= v < 6 / v >= 6 |
| `place_in_gap` (off = birdY - gapCenter, positive is below) | far above the opening, in front of the top pipe / close to the top pipe edge / a little above the middle / in the middle of the gap / a little below the middle / about one hop below the middle, near the bottom pipe / about two hops below the opening, in front of the bottom pipe / several hops below the opening, far under it | off < -50 / -50 to -35 / -35 to -10 / abs(off) <= 10 / 10 to 40 / 40 to 80 / 80 to 125 / off > 125 |
| `last_flap` (frames since last flap) | flapped just now / flapped a moment ago / has not flapped recently | < 6 / 6 to 20 / > 20 |
| `surroundings` | the ground is close below / the ceiling is close above / open sky above and below | groundY - (birdY + r) < 60, checked first / birdY - r < 60 / otherwise |
| `pipe_ahead.distance` (d = x1 - (birdX + r)) | between the pipes right now / right in front of the bird / close ahead / some distance ahead / far ahead | x1 <= birdX <= x2 / d < 40 / 40 to 100 / 100 to 200 / d >= 200 |
| `next_opening` (delta = followingCenter - currentCenter) | far above the bird / slightly above the bird / at about the same height as the bird / slightly below the bird / far below the bird | delta < -60 / -60 to -20 / abs(delta) <= 20 / 20 to 60 / delta > 60 |

Screen y grows downward. A negative `delta` means the next gap sits higher on the screen. The
sign inversion is commented in the code.

The `next_opening` phrases used to be bare comparatives: much higher, a little higher, about the
same height, a little lower, much lower. The first calibration put Jev at 0.39 to 0.56 on the
following-gap cases, which means it was not reading "much higher" and "much lower" as being
about the screen at all. The phrases are now explicitly spatial, and the state key says `next_opening` instead of
`following_gap`. The v1.1.0 wording compared the next opening with the current opening ("well
below this opening"). Jev still read that as being about the bird, so v1.2.0 compares with the
bird directly ("far below the bird"). The same run showed "level with the bottom pipe" being
read as aligned rather than blocked, so the two extreme `place_in_gap` phrases now say "far
below the opening, in front of the bottom pipe" and the mirror for the top.

The middle band wins on ties. `abs(off) <= 15` is checked before the neighbouring bands, and
`abs(delta) <= 20` likewise. On the outer edges the wider band wins: off = -50 is "close to the
top pipe edge", off = 50 is "close to the bottom pipe edge", delta = -60 is "slightly above the
bird", delta = 60 is "slightly below the bird".

The bucket helpers are exported individually for the calibration harness:
`verticalMotion(v)`, `placeInGap(offset)`, `lastFlap(frames)`,
`surroundings({birdY, birdRadius, groundY})`, `pipeDistance({birdX, birdRadius, x1, x2})`,
`followingGap(delta)`.

### Prose template

```
<RULES_TEXT> Right now the bird is {vertical_motion}, it is {place_in_gap}, it {last_flap},
and {surroundings}. {The bird is between the pipes right now. | The next pipe is {distance}.}
[ The next opening after this one is {next_opening}.]
```

The prose already begins with RULES_TEXT. Format B therefore sends `{ situation: prose }` and
nothing else. Sending a separate `rules` field next to it would state the rules twice.

### Example state

Input `{ birdX: 100, birdY: 440, birdVelocity: 5, birdRadius: 15, framesSinceFlap: 30,
nextPipe: { x1: 90, x2: 140, gapCenter: 400 }, followingPipe: { gapCenter: 280 },
groundY: 750, canvasHeight: 800 }` gives:

```json
{
  "rules": "The bird flies right at constant speed and cannot slow down or turn. Gravity pulls it down constantly. A flap gives one short upward hop, after which it falls again; flapping repeatedly stacks hops upward. A single hop from the middle of an opening carries the bird all the way up into the top pipe, so the bird should only hop when it is below the middle of the opening. Pipes arrive from the right; each has a top and bottom pipe with an opening between them. Touching a pipe, the ground or the ceiling ends the flight.",
  "bird": {
    "vertical_motion": "falling",
    "place_in_gap": "close to the bottom pipe edge",
    "last_flap": "has not flapped recently",
    "surroundings": "open sky above and below"
  },
  "pipe_ahead": { "distance": "between the pipes right now" },
  "next_opening": "far above the bird"
}
```

## Questions

File: `data/jev/jev-questions.js`. Global `JevQuestions`, also `module.exports`.
`JevQuestions.IDS = ["maneuver", "read", "danger"]`.
`JevQuestions.HOPS = { let_it_fall: 0, one_hop: 1, two_hops: 2, climb_hard: 3 }`.
`JevQuestions.HOP_SPACING_FRAMES = 8`.
`JevQuestions.build()` returns a fresh deep copy on every call.

```js
{
    maneuver: {
        type: "choice",
        instructions: "For the next short stretch of flight, which maneuver should the bird make? Flapping is the only way up; not flapping is the only way down.",
        criteria: {
            let_it_fall: "descend: make no flap and let gravity bring the bird down; the choice when the bird is at or above the middle of the opening, already rising, or close to the ceiling",
            one_hop: "one flap, lifting the bird by about one hop; the choice when the bird is a little below the middle and falling, or about one hop below the middle",
            two_hops: "two flaps in quick succession, lifting the bird by about two hops; the choice when the bird is about two hops below the opening",
            climb_hard: "three flaps in quick succession, lifting the bird by about three hops; the choice when the bird is several hops below the opening or close to the ground"
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

Fields read from the response: `answers.maneuver.{choice, probabilities, confidence}`,
`answers.read.{choice, probabilities, confidence}`, `answers.danger.{score, legend}`,
`usage.{input_tokens, output_tokens}`.

## Decision rule

An answer sets the flight plan to `JevQuestions.HOPS[answers.maneuver.choice]` flaps. The code
executes those flaps `JevQuestions.HOP_SPACING_FRAMES` frames apart, that is 8 frames, and then
the plan is empty and the bird falls until the next answer arrives.

A newer answer replaces whatever is left of the older plan. There is no queueing and no adding
up. The latest thing Jev said is the only plan.

There is no code override. The game does not flap on its own when it thinks Jev is wrong. It
does not block a flap it thinks is unsafe. It does not add a safety net near the ground or the
ceiling. `read` and `danger` are shown in the panel and never touch the controls. If the bird
flies badly, the fix is the vocabulary, the thresholds, or the question criteria. Never a rule
in the game loop.

Turning "three flaps" into three jumps 8 frames apart is not an override. Jev chose the three.
Code only owns the spacing, which is a physical constant of the game, not a judgement.

`doFlap()` is the only caller of `bird.jump()`.

## Freshness

Answers arrive later than the state they describe. Up to two requests are in flight at once, so
an answer can be stale.

Every request carries a tag `{ runId, frame }`. `runId` changes on every restart. On arrival an
answer is discarded only when `tag.runId` does not match the current run. A discarded answer
bumps `stats.discarded` and nothing else.

Answers are no longer discarded because the bird flapped in the meantime. That rule existed for
the old per-frame flap question and it was what made climbing impossible: every flap threw away
the answers that would have produced the next flap. With a maneuver plan, a flap in flight is
expected, and a newer answer simply replaces the rest of the plan.

## Request loop

- Cadence: one attempt every `JEV_TICK_EVERY` game frames (5 as shipped). With the jev world
  at 1/4 speed that is one attempt every 20 draw frames, about 3 per second.
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

## Death and restart

Death does not restart the flight by itself. The scene stays on the death screen until the user
clicks to fly again. Nothing is sent while dead, so a bird that dies while nobody is watching
costs nothing at all. An auto-restart would spend credits on a loop no one is looking at.

`runId` changes on the click that starts the new flight, so answers from the dead flight are
discarded.

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
`{ situation: prose }` and nothing else, because the prose already opens with RULES_TEXT.

Each case carries `expect`, an array of maneuvers a human pilot would accept. Several scenes
have more than one reasonable answer, so a single expected value would fail the model for no
good reason. The case passes when the chosen maneuver is in the array.

Reading the table: each row is one case with the chosen maneuver, abbreviated fall, 1hop, 2hop
or climb, its probability, and PASS or FAIL for each format. The summary gives the pass count
per format, the mean margin, the failure list, token totals, mean and p95 latency, and the
recommended format.

Margin: the probability of the chosen maneuver minus the highest probability among the
maneuvers that are not in the expected set. Positive means the model preferred an acceptable
answer over every unacceptable one. The harness reports the mean over the 25 cases.

Failures print the full maneuver distribution, the exact state sent, and the `read` and `danger`
answers, so you can see what the model understood.

Pass bar: the best format must reach at least 22 of 25, and cases 6, 7, 24, 25 must pass. Those
four are the ground danger, ceiling danger, and the two next-opening sign tests. A sign error
there means the vocabulary is lying to the model.

Exit codes: 0 pass, 1 below the bar, 2 transport or configuration failure. Do not wire the game
until it exits 0. On a 1, adjust the vocabulary or the question criteria in the shared files,
bump `JevTranslator.VERSION`, note the change here, and re-run.

`--dry-run` prints every scene in both formats without sending anything. Use it after any
vocabulary change.

Chosen format: JSON. In the v1.0.0 run the formats tied. In the v1.1.0 run JSON led prose
by 16 to 12, and the TypeSafe docs recommend sending state as an object. Prose is kept in the
harness as a comparison only.

### Calibration log

**v1.0.0, noul flap design.** JSON 23/25, prose 23/25. Failures: #2, the debatable case of
falling in the middle with the pipe far away; #24 and #25, both following-gap cases. Mean margin
about 0.15 on the old `abs(p - 0.5)` metric. 50 requests, 36.7k input tokens, mean latency
367 ms, p95 743 ms.

What the run taught us:

- The following-gap phrases did not land. Jev sat at 0.39 to 0.56 on #24 and #25, which is the
  model saying it has no opinion. That produced the `next_opening` rewording in v1.1.0.
- The latency was two to three times the draft estimate. Combined with the flap physics, the
  per-frame yes/no question could not climb. That produced the `maneuver` question in v1.1.0.

**v1.1.0, maneuver design, first wording.** JSON 16/25, prose 12/25, mean margin 0.21. Nine
JSON failures, all the same shape: the bird above the opening or rising, Jev picking `one_hop`
instead of `let_it_fall`. Its `read` answer was right in every one of them, so perception was
fine and the option descriptions were the problem. "A short bounce that roughly holds the
current height" read as the safe default, and nothing said that not flapping is how the bird
goes down. 50 requests, 38.5k input tokens, mean latency 349 ms, p95 857 ms.

**v1.1.0, maneuver design, reworded criteria.** JSON only, 22/25, mean margin 0.55. Each
option now leads with its direction (descend, hold height, climb a little, climb a lot) and
the instructions say that flapping is the only way up and not flapping the only way down.
Every "too high" case flipped to `let_it_fall` at 0.73 to 0.99. Remaining failures: #19, where
"level with the bottom pipe" was read as aligned; #25, where "well below this opening" was
still not read as a statement about the bird; #10, `climb_hard` at 45 px below, aggressive
but defensible. 25 requests, 21.6k input tokens, mean latency 387 ms.

**v1.2.0, bird-relative phrases.** JSON only, 23/25, mean margin 0.72, gate passed (exit 0).
Cases 6, 7, 24, 25 all pass; #19 now `climb_hard` at 0.95 and #25 `let_it_fall` at 0.47.
Remaining misses: #3, rising fast in the middle with the pipe far, `one_hop` at 0.48 against
`let_it_fall`; #10 as before. Both are borderline by design of the case, not model errors
worth another wording round. 25 requests, 21.6k input tokens, mean latency 386 ms, p95 803 ms.

**v1.3.1, hop physics in the rules.** JSON only, 24/25, mean margin 0.88, gate passed. The
rules now say that a hop from the middle reaches the top pipe, `one_hop` is for "a little below
the middle and falling", and `let_it_fall` covers "at or above the middle". Harness cases 17,
23 and 24 were corrected because their expectations assumed a hop from the centre was fine;
case 24 now puts the bird a little low so a hop is physically possible. Only #10 remains
(`climb_hard` at 45 px below, aggressive but defensible).

**v1.4.0, depth below the opening in hop units.** JSON only, 25/25, mean margin 0.95. The
slow-time traces showed the last flaw: below the middle the vocabulary had only "a little
below", "close to the bottom edge" and "far below", while two hops lift about 85 px and three
about 125 px. From 55 px below, "climb a lot" overshoots into the top pipe; from 150 px below
it is exactly right, and Jev could not tell the two apart. The bands below the middle are now
"a little below" (10 to 40), "about one hop below" (40 to 80), "about two hops below" (80 to
125) and "several hops below" (over 125), and each maneuver criterion names the depth it is
for. The middle band narrowed to 10 px so a hop from "in the middle" is never asked for.
Harness cases 4, 8, 10, 13 and 19 had their expectations aligned with the hop bands. This is
the version wired into the game.

### Flight log (headless simulator)

`npm run simulate` runs the scene loop against the real API. See harness/simulate.js.

- **Real time, v1.2.0, no warm start.** Dead on the ground at frame 46 with zero answers
  received. The first request takes 700 to 950 ms cold and the bird free-falls from the centre
  to the ground in 46 frames. Every flight in the browser died this way.
- **Real time, v1.3.1, warm start.** Still dead on the ground at frame 46 on both seeds.
  Latency was 490 to 650 ms, 30 to 40 frames. The physics outrun the round trip; no wording
  changes that.
- **Lockstep, v1.2.0, tick 9.** 284 frames, score 0, died by hopping from the centre into the
  top pipe of the first gap. Readings were right on every tick.
- **Lockstep, v1.3.1, tick 9.** Scores 1 and 2 on seeds 1 and 2.
- **Lockstep, v1.3.1, tick 5.** Scores 7 and 8, about 20 s of flight, on seeds 3 and 1; score
  1 on seed 2. Jev flies when the world waits for it and asks often enough.

- **Slow time, v1.3.1.** Scale 2 or 3 with tick 9: still dead at the first pipe, because the
  decision loop (tick plus latency) was about 18 game frames and "a little below the middle"
  was skipped over between two decisions. Scale 3 tick 5: scores 0 and 1. Scale 4 tick 5:
  0 and 2. Scale 4 tick 3: 1 and 0. Scale 6 tick 5: 3 and 3, over a minute of flight each.
- **Slow time, v1.4.0.** Scale 4 tick 5: scores 2 and 1, 27 to 29 s each. Scale 6 tick 5:
  2 and 3, 55 to 68 s each. Shipped as scale 4, tick 5: a pipe every 8 s, still watchable.

The conclusion: the description is good enough for Jev to fly. At normal game speed the
physics outrun a 300 to 650 ms round trip, so the jev scene runs at 1/4 speed with a 5-frame
tick. Lockstep remains the mode for judging the description alone.

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
- **Latency.** Measured at 367 ms in the harness and about 280 ms in the browser, roughly 17
  frames. The maneuver plan is the answer to it, not a workaround for it. The bird still acts on
  a picture of the world that is a sixth of a second old. That is part of the experiment.
- **Flap spacing is code, not model.** The 8 frame gap between the flaps of one maneuver is a
  constant in the code. Jev chooses how many flaps, never when.
- **No restart while dead.** The bird waits for a click. This is a cost decision, not a game
  design one.

## Versioning

`JevTranslator.VERSION` covers the vocabulary, the thresholds, RULES_TEXT, the state shape, and
the prose template. Bump the patch number for wording that does not move a boundary. Bump the
minor number when a threshold moves or a phrase changes meaning. Bump the major number when the
state shape or the question set changes.

Current version is 1.4.0. 1.1.0 carried the `next_opening` key rename, the prose change for
being between the pipes, and the `maneuver` question that replaced the `flap` noul. 1.2.0
made the two extreme `place_in_gap` phrases and all `next_opening` phrases bird-relative and
reworded the maneuver criteria. 1.3.x added the hop physics sentence to RULES_TEXT and moved
the `one_hop` / `let_it_fall` boundary to the middle of the opening. 1.4.0 sized the bands
below the middle in hops and tied each maneuver to a band. By the rule above a question set change is a major bump; these
stayed at minor because the scene was not wired into the game yet and no calibration of the
new design had been published. The next question set change bumps the major number.

Every bump means the previous calibration run is void. Re-run `npm run calibrate`, update the
chosen format line, and add an entry to the calibration log.

## Debug mode

The pilot loop is asynchronous, so the interesting bugs are all about timing: which frame a
request describes, which frame its answer lands on, how much the world moved in between. None
of that is visible from the canvas. Debug mode makes it visible and, where it helps, makes it
stop moving.

### What made it necessary

Three measurements from the first wired-up flights:

- The **first** request takes 700-850 ms. The connection is cold, and nothing in the pipeline is
  warm. Every later request is far quicker.
- The bird free-falls from `height/2` to the ground in **46 frames**. That is less than the first
  request takes, so every early flight died before its first answer ever arrived. The pilot was
  never the problem; the takeoff was.
- Steady-state latency in the browser is about **23 frames**. In a headless lockstep run, where
  the world is frozen while a request is in flight, Jev flew competently with the same
  vocabulary and the same questions. So the description is good enough; the staleness is what
  costs lives.

Warm start answers the first two. Lockstep isolates the third: turn it on and any remaining
mistake belongs to the description, not to the delay.

### Warm start (always on)

`start()` describes the opening scene, sends one request tagged frame 0, and holds everything
still: the bird hovers at `height/2` with zero velocity, the pipes do not move, there is no
gravity and the frame counter stays at 0. Status is `waiting`. When the answer lands it becomes
the first plan and the flight begins on frame 1. If the request fails the scene waits out the
normal client backoff and asks again; it never takes off blind. Nothing else is sent during the
wait.

### Keys

Only `JevScene.keyPressed` reads them, so no other scene ever sees them.

| key | what it does |
| --- | --- |
| `P` | pause: no frame, no physics, no pipes, no sends, no draining. Answers already in flight land in the inbox and sit there, still fresh, because no frames passed. `draw()` and the panel keep running. |
| `N` | one frame, while paused |
| `M` | frames until the next event (a send, a drained answer, a hop, a death), 600 frames at most, then paused again |
| `L` | lockstep on/off |

`M` stops at a send rather than waiting for its answer, so it can never spin on something that
has not arrived yet. Press it again once the answer is in and it drains it.

### Lockstep

With `L` on, the scene freezes the moment a request goes out and thaws when its answer is
drained, then runs normally until the next tick. `maxInFlight` is effectively 1. Latency costs
zero frames and the wall clock stretches instead. Status is `lockstep` while frozen, `live`
between requests. A request that errors never answers, so the freeze also lifts when nothing is
left in flight.

### Trace

The scene keeps an event log, capped at 2000 records, in the same JSONL shape
`harness/simulate.js` writes: one `header` per run, then `send`, `recv`, `hop` and `death`.
A death records its cause in the order pipe, ground, ceiling. Every request carries a `reqId`
from the client, so a `send` and its `recv` can be paired and the latency read in both frames
and milliseconds. A restart appends a new header rather than clearing the log, so several
flights can be compared in one file.

The panel shows the last 12 records formatted like the simulator's timeline, newest at the
bottom, and the **download trace** button saves the whole log as
`jev-trace-<runId>-<timestamp>.jsonl`. A browser trace and a headless one can then be read side
by side, or diffed.

### Status

The panel dot and label show one of `waiting`, `live`, `paused`, `lockstep`, `hidden`,
`backoff`, `dead`. Death still waits for a click, space or enter, as before.

## Slow game time

Debug mode made the timing visible; this is what the timing said. Real-time flights were not
losing because Jev read the scene badly, they were losing because the world moved too far
between the question and the answer. So the jev scene, and only the jev scene, runs its world
slower.

### Why

- A measured TypeSafe round trip is **390-650 ms**. At 60 fps that is **23-40 draw frames**.
- The bird free-falls from the centre of the canvas to the ground in **45 frames**.

The answer therefore arrives after most of a fatal fall has already happened. In the headless
simulator, where lockstep lets the world wait for every answer, the same vocabulary and the
same questions score **7-8 pipes**. The description is fine; the clock is the problem.

Slowing the physics closes the gap without touching the contract: a 400 ms answer that was 24
draw frames old is now 8 frames of game time old, which is roughly what lockstep gives for
free.

### What changes

`JEV_TIME_SCALE = 4` at the top of `data/scenes/jev-scene.js` is the whole knob (with
`JEV_TICK_EVERY = 5`, chosen from the simulator runs in the flight log). Everything
else derives from it, `JEV_DT = 1 / JEV_TIME_SCALE` being the fractional step.

- **Physics.** `JevBird` and `JevPipe`, two small subclasses at the bottom of the scene file,
  are the ordinary `Bird` and `Pipe` with their `update()` multiplied by `dt`. The scene builds
  those instead of the base classes; every other scene keeps its full frame step. `jump()` is
  untouched, a hop is still worth `BIRD_JUMP_POWER`.
- **Cadence in game time.** The tick fires every `JEV_TICK_EVERY * JEV_TIME_SCALE` draw frames
  and hops land `HOP_SPACING_FRAMES * JEV_TIME_SCALE` draw frames apart, so 5 and 8 still mean
  5 and 8 *game* frames. `this.gameFrame` is the same clock in game time.
- **Translator input.** `framesSinceFlap` keeps counting draw frames, but the translator is
  handed `framesSinceFlap * JEV_DT`, so "flapped just now" still means what it meant before.
- **Trace and panel.** The header carries `"timeScale"`, and `send`, `recv`, `hop` and `death`
  carry a `gameFrame` next to the draw-frame `frame`. Timeline lines still print draw frames;
  the panel's meta block gains a **speed** row reading `1/3 (jev world)`.

### What does not change

The drawing. 60 fps, the same canvas, the same pipes; the world just travels a third as far per
frame, which reads as slow motion rather than as a slow game.

The contract. Same state vocabulary, same questions, same maneuvers, same translator version.
Nothing Jev sees knows about the time scale.

The hop physics, near enough. A finer Euler step integrates slightly less: a hop rises about
**46 px** instead of 48, because gravity is applied in thirds of a frame. The safe band is 47
px, so "a single hop from the middle of an opening carries the bird all the way up into the top
pipe" stays true and the rules sentence needs no edit. Measured in the browser: 46.0 px over 45
draw frames (15 game frames) against 48.0 px over 15 frames for the plain `Bird`.

The debug keys. `P`, `N`, `M`, `L` behave exactly as the Debug mode section describes; `N` still
steps one *draw* frame, which is now a third of a game frame.

### How to tune it

Change the constant, nothing else. 1 is the old behaviour, 3 is what the flights above used. It
is deliberately not a runtime key: a time scale that changes mid-flight makes a trace unreadable
and the panel would have to explain it.

The headless simulator mirrors it with `--time-scale=N`, which does the same three things (dt
physics, tick and hop spacing in game time, translator input divided). A browser trace at
`timeScale 3` and a `--time-scale=3` headless trace are comparable line by line.

### Measured in the browser with a 400 ms stub

- Pipes move **0.67 px** per draw frame, so two sends 27 frames apart show a pipe **18 px**
  closer.
- Requests go out every **27 draw frames** (about 450 ms), which is the 9-frame tick in game
  time.
- Hops inside one plan land **24 draw frames** apart; a fresh answer still resets the plan
  immediately, as before.
- Flights last **460-770 draw frames** instead of dying at 42, and the stub pilot passes pipes.
