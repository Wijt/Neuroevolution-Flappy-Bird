"use strict";

/*
 * Headless flight simulator for the Jev pilot, contract v2.1.
 *
 * Runs the JevScene loop without p5 and without a browser: a real-time 60 fps
 * timeline, the real physics from data/flappybird/*, the real v2.1 scene
 * translator and the real v2.1 question set. The loop never waits for an
 * answer: a request is fired on a wall-clock cadence, the frames keep ticking,
 * and the answer is drained at the top of whichever frame it happens to arrive
 * on.
 *
 * v2 moved the latency problem from the game into the request: predict the
 * world `leadFrames` ahead with the bird left alone, describe THAT world, and
 * hold the answer until the frame it was about (targetFrame).
 *
 * v2.1 adds the thing this harness is here to measure: freshness by premise,
 * not by flap. An answer is no longer thrown away just because the bird flapped
 * in the meantime. When a held candidate comes due, the harness re-describes the
 * world at lead 0 and asks JevTranslator.premiseHolds(askedFields,
 * currentFields): if the words the answer rested on (position, and motion where
 * it matters) still hold, the answer is still about the world the bird is in, so
 * it is applied. Otherwise it is superseded with reason `premise`.
 *
 *   node harness/simulate.js [--mock] [--seed=N] [--runs=N] [--max-frames=N]
 *                            [--tick-ms=N] [--max-in-flight=N] [--late-frames=N]
 *                            [--lead-ms=N] [--no-lead] [--time-scale=N]
 *                            [--height=N] [--width=N] [--quiet]
 *
 * At most one FLAP is applied per frame; any candidate still held behind it
 * waits for the next frame and is judged again from scratch.
 *
 * --mock swaps the transport for a local fake (350 +-120 ms, the FLAP criterion
 * applied to the snapshot it was sent) so the whole pipeline can be exercised
 * without a key. Every run writes a JSONL trace under
 * <os tmpdir>/flappy-jev-sim/.
 *
 * The `send` timeline line shows the PREDICTED scene -- that is what Jev is
 * being asked about. The trace keeps the unpredicted numbers beside it under
 * `actual`.
 *
 * Exit codes: 0 ran, 2 config/transport failure.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const JevTranslator = require("../data/jev/scene-translator.js");
const JevQuestions = require("../data/jev/jev-questions.js");

/* -------------------------------------------------------------- constants */
// Re-implemented rather than required: data/constants.js and the game classes
// assign p5 globals and call p5 functions, so they cannot be loaded in Node.

const BIRD_R = 25;
const BIRD_X = 100;
const BIRD_JUMP_POWER = 6;
const JEV_COLLISION_R = BIRD_R - 10;

const PIPE_GAP_H = 125;
const PIPE_WIDTH = 50;
const PIPE_SCROOL = 2;
const PIPE_BETWEEN = 200;
const PIPE_NO_GAP_ZONE = 150;

const GROUND_HEIGHT = 50;
const GRAVITY = 0.4;

const DEFAULT_HEIGHT = 900;
const FRAME_MS = 1000 / 60;

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const REQUEST_TIMEOUT_MS = 10000;

// wider than v2's +-50 ms: the point of v2.1 is that a late answer can still be
// good, so the mock has to produce plenty of late ones
const MOCK_LATENCY_MS = 350;
const MOCK_JITTER_MS = 120;

const LEAD_ALPHA = 0.3;
const LEAD_INITIAL_MS = 400;

const QUESTION_ID = "decision";

const FLAP = JevQuestions.FLAP;
const WAIT = JevQuestions.WAIT;

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
    const opts = {
        mock: false,
        quiet: false,
        seed: 1,
        runs: 1,
        maxFrames: 3600,
        tickMs: 250,
        maxInFlight: 8,
        lateFrames: 6,
        leadMs: null,
        noLead: false,
        timeScale: 1,
        height: DEFAULT_HEIGHT,
        width: null
    };

    const integers = {
        "--seed": "seed",
        "--runs": "runs",
        "--max-frames": "maxFrames",
        "--tick-ms": "tickMs",
        "--max-in-flight": "maxInFlight",
        "--late-frames": "lateFrames",
        "--lead-ms": "leadMs",
        "--time-scale": "timeScale",
        "--height": "height",
        "--width": "width"
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === "--mock") {
            opts.mock = true;
            continue;
        }
        if (arg === "--quiet") {
            opts.quiet = true;
            continue;
        }
        if (arg === "--no-lead") {
            opts.noLead = true;
            continue;
        }

        let name = arg;
        let value = null;
        const eq = arg.indexOf("=");
        if (eq !== -1) {
            name = arg.slice(0, eq);
            value = arg.slice(eq + 1);
        }

        const key = integers[name];
        if (key === undefined) {
            console.error("unknown flag: " + arg);
            process.exit(2);
        }

        if (value === null) {
            i++;
            value = argv[i];
        }

        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 0) {
            console.error(name + " needs a non-negative integer");
            process.exit(2);
        }
        opts[key] = n;
    }

    if (opts.width === null) opts.width = Math.round(opts.height * 9 / 16);
    if (opts.runs < 1) opts.runs = 1;
    if (opts.tickMs < 1) opts.tickMs = 1;
    if (opts.maxInFlight < 1) opts.maxInFlight = 1;
    if (!(opts.timeScale >= 1)) opts.timeScale = 1;

    if (opts.noLead) opts.leadMode = "none";
    else if (opts.leadMs !== null) opts.leadMode = "fixed";
    else opts.leadMode = "ema";

    return opts;
}

/* -------------------------------------------------------------- utilities */

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, ms)); });
}

// mulberry32: small, fast, seedable. Stands in for p5's random(min, max).
function makeRandom(seed) {
    let a = seed >>> 0;
    return function (min, max) {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        if (min === undefined) return unit;
        if (max === undefined) return unit * min;
        return min + unit * (max - min);
    };
}

function pad(text, width) {
    const s = String(text);
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(text, width) {
    const s = String(text);
    return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function mean(values) {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function percentile(sorted, q) {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index];
}

function frameTag(frame) {
    let s = String(frame);
    while (s.length < 4) s = "0" + s;
    return "f" + s;
}

function prob(p) {
    const n = Number(p);
    if (!Number.isFinite(n)) return " n/a";
    const text = n.toFixed(2);
    return text.charAt(0) === "0" ? text.slice(1) : text;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// "inside the gap, lower half" -> "lower half"; the other two are short already
function shortPosition(position) {
    const text = String(position || "?");
    const prefix = "inside the gap, ";
    return text.indexOf(prefix) === 0 ? text.slice(prefix.length) : text;
}

// The longest run of frames over which the bird gained altitude, and how long it
// took: from a local minimum of altitude (a local MAXIMUM of y, because y grows
// downward) to the following local maximum of altitude. This is the metric v2.1
// targets -- a pilot that can only land one flap per round trip never gets a
// long climb, because gravity eats the gain between answers.
function longestClimb(ys) {
    const best = { rise: 0, frames: 0, fromFrame: 0, toFrame: 0 };
    if (ys.length < 2) return best;

    let startIndex = 0;
    let climbing = false;

    function close(endIndex) {
        if (!climbing) return;
        const rise = ys[startIndex] - ys[endIndex];
        if (rise > best.rise) {
            best.rise = rise;
            best.frames = endIndex - startIndex;
            best.fromFrame = startIndex + 1;
            best.toFrame = endIndex + 1;
        }
        climbing = false;
    }

    for (let i = 1; i < ys.length; i++) {
        if (ys[i] < ys[i - 1]) {
            // y falling = bird rising
            if (!climbing) {
                climbing = true;
                startIndex = i - 1;
            }
        } else if (ys[i] > ys[i - 1]) {
            close(i - 1);
        }
        // a flat frame neither starts nor ends a climb
    }
    close(ys.length - 1);

    return best;
}

/* ------------------------------------------------------------------ world */
// Straight ports of data/flappybird/bird.js, data/flappybird/pipe.js and
// circleRect() from data/utils.js, minus the drawing.

class Bird {
    constructor(x, y) {
        this.pos = { x: x, y: y };
        this.radius = BIRD_R;

        this.live = true;
        this.score = 0;
        this.velocity = 0;
    }

    jump() {
        this.velocity = 0;
        this.velocity -= BIRD_JUMP_POWER;
    }

    update(height, dt) {
        dt = dt || 1;
        if (this.pos.y < height - GROUND_HEIGHT) {
            this.pos.y += this.velocity * dt;
            this.velocity += GRAVITY * dt;
        } else {
            this.pos.y = height - GROUND_HEIGHT;
        }
    }
}

class Pipe {
    // `world` stands in for sceneManager.getActiveScene() plus the p5 globals
    // height and random().
    constructor(x, y, world) {
        this.pos = { x: x, y: y };
        this.gapH = PIPE_GAP_H;
        this.width = PIPE_WIDTH;
        this.velocity = PIPE_SCROOL;
        this.world = world;

        this.hasPoint = true;

        this.buildRects();

        world.pipes.push(this);
    }

    buildRects() {
        this.topPipe = {
            x1: this.pos.x - this.width / 2,
            y1: 0,
            x2: this.pos.x + this.width / 2,
            y2: this.pos.y - this.gapH / 2
        };
        this.bottomPipe = {
            x1: this.pos.x - this.width / 2,
            y1: this.pos.y + this.gapH / 2,
            x2: this.pos.x + this.width / 2,
            y2: this.world.height
        };
    }

    update(dt) {
        this.pos.x -= this.velocity * (dt || 1);

        if (this.pos.x < -this.width / 2) {
            const pipes = this.world.pipes;
            pipes.splice(pipes.indexOf(this), 1);
            new Pipe(
                pipes[pipes.length - 1].pos.x + PIPE_BETWEEN + PIPE_WIDTH,
                this.world.random(PIPE_NO_GAP_ZONE, this.world.height - PIPE_NO_GAP_ZONE),
                this.world
            );
        }

        this.buildRects();
    }
}

function circleRect(bird, rectV) {
    let testX = bird.pos.x;
    let testY = bird.pos.y;

    if (bird.pos.x < rectV.x1) testX = rectV.x1;
    else if (bird.pos.x > rectV.x2) testX = rectV.x2;
    if (bird.pos.y < rectV.y1) testY = rectV.y1;
    else if (bird.pos.y > rectV.y2) testY = rectV.y2;

    const distX = bird.pos.x - testX;
    const distY = bird.pos.y - testY;
    const distance = Math.sqrt((distX * distX) + (distY * distY));

    return distance <= bird.radius - 10;
}

/* ------------------------------------------------------------- transports */
// A transport resolves { body, modelMs }. modelMs is the upstream service time
// reported by the edge when it bothers to tell us.

// Every request to TypeSafe costs one round trip on a warm connection and three
// on a cold one (DNS + TCP + TLS). Node drops idle sockets after 4 s, so without
// a long-lived dispatcher a cadence of one request per 100 ms would still pay
// the cold price now and then. Same numbers as server/server.js.
function makeDispatcher() {
    const { Agent } = require("undici");
    return new Agent({
        keepAliveTimeout: 60 * 1000,
        keepAliveMaxTimeout: 10 * 60 * 1000,
        connections: 4
    });
}

function realTransport(apiKey) {
    const dispatcher = makeDispatcher();

    return async function (state, questions, signal) {
        const response = await fetch(ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey
            },
            body: JSON.stringify({
                state: state,
                model: MODEL,
                questions: questions
            }),
            signal: signal,
            dispatcher: dispatcher
        });

        const rawModelMs = response.headers.get("x-envoy-upstream-service-time");
        const modelMs = rawModelMs == null ? null : Number.parseInt(rawModelMs, 10);

        if (!response.ok) {
            let detail = "";
            try {
                detail = (await response.text()).slice(0, 200);
            } catch (err) {
                detail = "";
            }
            throw new Error("http " + response.status + " " + detail);
        }

        const body = await response.json();
        return { body: body, modelMs: Number.isFinite(modelMs) ? modelMs : null };
    };
}

// The mock mirrors the FLAP criterion from jev-questions.js exactly, reading the
// same two phrases Jev reads. It is not a smarter pilot than Jev, it is the same
// pilot with no network and no judgement -- which is what makes it useful: any
// hold / supersede / stale behaviour a mock run shows is the harness, not the
// model.
function mockChoice(snapshot) {
    const bird = (snapshot && snapshot.bird) || {};
    const position = String(bird.position || "");
    const motion = String(bird.motion || "");

    if (position === "below the gap") return FLAP;
    if (position === "inside the gap, lower half" && motion !== "rising") return FLAP;
    return WAIT;
}

function mockTransport(random) {
    return function (state, questions, signal) {
        return new Promise(function (resolve, reject) {
            function onAbort() {
                clearTimeout(timer);
                reject(new Error("aborted"));
            }

            const jitter = (random() * 2 - 1) * MOCK_JITTER_MS;
            const delay = MOCK_LATENCY_MS + jitter;

            const timer = setTimeout(function () {
                if (signal != null) signal.removeEventListener("abort", onAbort);

                const choice = mockChoice(state);
                const p = 0.91;
                const probabilities = {};
                probabilities[FLAP] = choice === FLAP ? p : 1 - p;
                probabilities[WAIT] = choice === WAIT ? p : 1 - p;

                const answers = {};
                answers[QUESTION_ID] = {
                    choice: choice,
                    confidence: p,
                    probabilities: probabilities
                };

                resolve({
                    body: {
                        answers: answers,
                        usage: { input_tokens: 0, output_tokens: 0 }
                    },
                    modelMs: null
                });
            }, delay);

            if (signal != null) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }
        });
    };
}

/* ----------------------------------------------------------------- client */
// Same shape as data/jev/jev-client.js: fire and forget, answers land in an
// inbox the loop drains once per frame, errors never propagate.

class SimClient {
    constructor(opts) {
        this.transport = opts.transport;
        this.maxInFlight = opts.maxInFlight;
        this.timeoutMs = opts.timeoutMs;

        this.inFlight = 0;
        this.backoffUntilMs = 0;
        this.backoffStepMs = 0;

        this.inbox = [];
        this.controllers = [];

        this.nextReqId = 0;

        this.stats = {
            requests: 0,
            answers: 0,
            errors: 0,
            inputTokens: 0,
            outputTokens: 0,
            lastError: null
        };

        this.errorLog = [];
    }

    canSend() {
        if (this.inFlight >= this.maxInFlight) return false;
        if (Date.now() < this.backoffUntilMs) return false;
        return true;
    }

    // Returns the request id when a request actually went out, 0 otherwise.
    send(state, questions, tag) {
        if (!this.canSend()) return 0;

        const self = this;
        const controller = new AbortController();
        controller.deliberateAbort = false;

        const reqId = ++this.nextReqId;
        const startedAt = Date.now();
        let timer = setTimeout(function () { controller.abort(); }, this.timeoutMs);

        this.controllers.push(controller);
        this.inFlight++;
        this.stats.requests++;

        function done() {
            if (timer != null) {
                clearTimeout(timer);
                timer = null;
            }
            self.inFlight--;
            const i = self.controllers.indexOf(controller);
            if (i !== -1) self.controllers.splice(i, 1);
        }

        Promise.resolve()
            .then(function () {
                return self.transport(state, questions, controller.signal);
            })
            .then(function (result) {
                const body = result != null ? result.body : null;
                if (body == null || body.answers == null) throw new Error("no answers in the response");

                const usage = body.usage || {};
                const latencyMs = Date.now() - startedAt;

                self.inbox.push({
                    reqId: reqId,
                    tag: tag,
                    answers: body.answers,
                    usage: usage,
                    latencyMs: latencyMs,
                    modelMs: result.modelMs != null ? result.modelMs : null
                });

                self.stats.answers++;
                self.stats.inputTokens += usage.input_tokens || 0;
                self.stats.outputTokens += usage.output_tokens || 0;

                // a good answer clears the backoff
                self.backoffStepMs = 0;
                self.backoffUntilMs = 0;
            })
            .catch(function (error) {
                // abortAll() is us pulling the plug on purpose, that is not an error
                if (controller.deliberateAbort) return;
                self.noteError(error, reqId, tag);
            })
            .then(done, done);

        return reqId;
    }

    noteError(error, reqId, tag) {
        const message = (error && error.name === "AbortError")
            ? "timeout after " + this.timeoutMs + " ms"
            : ((error && error.message) ? error.message : String(error));

        this.stats.errors++;
        this.stats.lastError = message;
        this.errorLog.push({ reqId: reqId, frame: tag != null ? tag.sentFrame : null, message: message });

        if (this.backoffStepMs === 0) this.backoffStepMs = 1000;
        else this.backoffStepMs = Math.min(this.backoffStepMs * 2, 8000);

        this.backoffUntilMs = Date.now() + this.backoffStepMs;
    }

    takeAnswer() {
        if (this.inbox.length === 0) return null;
        return this.inbox.shift();
    }

    abortAll() {
        this.controllers.slice().forEach(function (controller) {
            controller.deliberateAbort = true;
            try {
                controller.abort();
            } catch (error) {
                // nothing sensible to do, the request is going away either way
            }
        });
        this.inbox = [];
    }
}

/* -------------------------------------------------------------------- run */

class SimRun {
    constructor(opts, seed, runIndex, trace) {
        this.opts = opts;
        this.seed = seed;
        this.runIndex = runIndex;
        this.trace = trace;

        this.height = opts.height;
        this.width = opts.width;

        this.client = new SimClient({
            transport: opts.transport,
            maxInFlight: opts.maxInFlight,
            timeoutMs: REQUEST_TIMEOUT_MS
        });

        const random = makeRandom(seed);
        this.random = random;

        this.world = { height: this.height, pipes: [], random: random };
        this.pipes = this.world.pipes;

        this.bird = new Bird(BIRD_X, this.height / 2);

        // JevScene.start(): the Pipe constructor pushes into the scene's pipes
        const pipeCount = this.width / (PIPE_BETWEEN + PIPE_WIDTH);
        for (let i = 1; i <= pipeCount + 2; i++) {
            new Pipe(
                this.width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH),
                random(PIPE_NO_GAP_ZONE, this.height - PIPE_NO_GAP_ZONE),
                this.world
            );
        }

        this.nextPipe = null;

        // slow game time: the world runs timeScale times slower, the cadence and
        // the lead stay in wall time because that is where latency lives
        this.timeScale = opts.timeScale;
        this.dt = 1 / this.timeScale;

        this.tickMs = opts.tickMs;
        this.lateFrames = opts.lateFrames;

        this.leadMode = opts.leadMode;
        this.leadMs = this.leadMode === "none"
            ? 0
            : (this.leadMode === "fixed" ? opts.leadMs : LEAD_INITIAL_MS);

        this.frame = 0;
        this.runId = runIndex + 1;
        this.lastSendMs = -Infinity;

        // candidates waiting for their targetFrame
        this.held = [];

        // bookkeeping the game itself does not need
        this.flaps = 0;
        this.candidatesHeld = 0;
        this.applied = 0;
        this.appliedFlap = 0;
        this.appliedWait = 0;
        this.superseded = 0;
        this.stale = 0;
        this.discarded = 0;
        this.latenciesMs = [];
        this.latenciesFrames = [];
        this.modelMsValues = [];
        this.leadFramesValues = [];
        this.lateByValues = [];
        this.birdYs = [];
        this.death = null;
        this.warmStartMs = null;

        this.write({
            t: "header",
            version: 2,
            seed: seed,
            runId: this.runId,
            tickMs: this.tickMs,
            maxInFlight: opts.maxInFlight,
            lateFrames: this.lateFrames,
            timeScale: this.timeScale,
            leadMode: this.leadMode,
            freshness: "premise",
            translator: JevTranslator.VERSION
        });
    }

    line(text) {
        if (!this.opts.quiet) console.log(text);
    }

    write(record) {
        this.trace.write(JSON.stringify(record) + "\n");
    }

    /* ------------------------------------------------------------ scene */

    // same selecting criterion as the watch scene, used for collisions/score
    selectNextPipe() {
        return this.pipes.filter(function (pipe) {
            return pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R);
        })[0];
    }

    // the v2 translator takes the whole pipe list and picks the pipe itself
    pipeList() {
        return this.pipes.map(function (pipe) {
            return {
                x1: pipe.topPipe.x1,
                x2: pipe.topPipe.x2,
                gapTop: pipe.topPipe.y2,
                gapBottom: pipe.bottomPipe.y1
            };
        });
    }

    input() {
        return {
            birdX: this.bird.pos.x,
            birdY: this.bird.pos.y,
            birdVelocity: this.bird.velocity,
            birdRadius: JEV_COLLISION_R,
            groundY: this.height - GROUND_HEIGHT,
            pipes: this.pipeList()
        };
    }

    describe(leadFrames) {
        return JevTranslator.describeScene(this.input(), leadFrames, this.dt);
    }

    leadFrames() {
        if (this.leadMode === "none") return 0;
        return Math.round(this.leadMs / FRAME_MS);
    }

    noteLatency(latencyMs) {
        if (this.leadMode !== "ema") return;
        this.leadMs = (1 - LEAD_ALPHA) * this.leadMs + LEAD_ALPHA * latencyMs;
    }

    /* ------------------------------------------------------------- loop */

    // One tick of JevScene.update(), minus the browser-only guards.
    // Returns false once the flight is over.
    step() {
        this.frame++;

        if (!this.bird.live) return false;

        this.drainAnswers();
        this.applyHeld();

        const dt = this.dt;
        this.pipes.forEach(function (pipe) {
            pipe.update(dt);
        });

        this.bird.update(this.height, this.dt);
        this.birdYs.push(this.bird.pos.y);

        this.nextPipe = this.selectNextPipe();

        let cause = null;

        if (this.nextPipe != null) {
            const hitted = circleRect(this.bird, this.nextPipe.topPipe) ||
                circleRect(this.bird, this.nextPipe.bottomPipe);
            if (hitted) {
                this.bird.live = false;
                cause = "pipe";
            }

            if (this.bird.pos.x > this.nextPipe.pos.x && this.nextPipe.hasPoint) {
                this.bird.score++;
                this.nextPipe.hasPoint = false;
            }
        }

        if (this.bird.pos.y > this.height - GROUND_HEIGHT) {
            this.bird.live = false;
            if (cause == null) cause = "ground";
        }

        if (this.bird.pos.y - JEV_COLLISION_R <= 0) {
            this.bird.live = false;
            if (cause == null) cause = "ceiling";
        }

        if (!this.bird.live) {
            this.noteDeath(cause);
            return false;
        }

        this.maybeSend();
        return true;
    }

    doFlap() {
        this.bird.jump();
        this.flaps++;

        this.write({ t: "flap", frame: this.frame });
        this.line(frameTag(this.frame) + " flap");
    }

    noteDeath(cause) {
        const pipe = this.nextPipe;

        this.death = { frame: this.frame, cause: cause, score: this.bird.score };

        this.write({
            t: "death",
            frame: this.frame,
            cause: cause,
            score: this.bird.score,
            birdY: round2(this.bird.pos.y),
            gapTop: pipe != null ? pipe.topPipe.y2 : null,
            gapBottom: pipe != null ? pipe.bottomPipe.y1 : null,
            pipeX1: pipe != null ? round2(pipe.topPipe.x1) : null
        });

        this.line(frameTag(this.frame) + " DEATH " + cause + " score " + this.bird.score);

        // the scene aborts every call the frame after the bird dies
        this.client.abortAll();
        this.held = [];
    }

    /* --------------------------------------------------------- answers */

    answerOf(message) {
        const answer = (message.answers && message.answers[QUESTION_ID]) || {};
        return {
            choice: answer.choice !== undefined ? answer.choice : null,
            confidence: answer.confidence !== undefined ? answer.confidence : null,
            probabilities: answer.probabilities || null
        };
    }

    // Every answered request turns into one candidate. Nothing is judged here:
    // freshness is decided at the targetFrame, against the premise the question
    // was asked under.
    drainAnswers() {
        let message = this.client.takeAnswer();
        while (message != null) {
            const tag = message.tag || {};
            const answer = this.answerOf(message);

            this.noteLatency(message.latencyMs);

            this.latenciesMs.push(message.latencyMs);
            this.latenciesFrames.push(this.frame - tag.sentFrame);
            if (message.modelMs != null) this.modelMsValues.push(message.modelMs);

            let outcome;
            if (tag.runId !== this.runId) {
                // an answer about a flight that is already over is worthless
                this.discarded++;
                outcome = "discarded";
            } else {
                this.held.push({
                    reqId: message.reqId,
                    targetFrame: tag.targetFrame,
                    askedFields: tag.askedFields,
                    answer: answer
                });
                this.candidatesHeld++;
                outcome = "held";
            }

            this.noteRecv(message, answer, outcome);

            message = this.client.takeAnswer();
        }
    }

    noteRecv(message, answer, outcome) {
        const tag = message.tag || {};
        const latencyFrames = this.frame - tag.sentFrame;

        this.write({
            t: "recv",
            frame: this.frame,
            reqId: message.reqId,
            latencyMs: message.latencyMs,
            latencyFrames: latencyFrames,
            modelMs: message.modelMs,
            choice: answer.choice,
            confidence: answer.confidence,
            outcome: outcome
        });

        const p = answer.confidence != null
            ? answer.confidence
            : (answer.probabilities != null && answer.choice != null
                ? answer.probabilities[answer.choice]
                : null);

        this.line(frameTag(this.frame) + " recv " + pad("#" + message.reqId, 4) +
            " (" + padLeft(message.latencyMs, 3) + "ms" +
            (message.modelMs != null ? ", model " + message.modelMs + "ms" : "") + ") " +
            (answer.choice || "?") + " " + prob(p) + " " + outcome);
    }

    // Held candidates come due at their targetFrame. Anything still in the
    // future waits; anything too late is stale; everything else is judged on its
    // premise -- if the words the question was asked under still describe the
    // bird, the answer is still about the world the bird is in.
    applyHeld() {
        if (this.held.length === 0) return;

        this.held.sort(function (a, b) { return a.targetFrame - b.targetFrame; });

        const current = this.describe(0);
        const currentFields = current != null ? current.fields : null;

        const keep = [];
        let flapped = false;

        for (let i = 0; i < this.held.length; i++) {
            const item = this.held[i];

            // at most one flap per frame: whatever is left waits for the next
            // frame, where it is judged again against the world the flap made
            if (flapped) {
                keep.push(item);
                continue;
            }

            if (item.targetFrame > this.frame) {
                keep.push(item);
                continue;
            }

            const lateBy = this.frame - item.targetFrame;

            if (lateBy > this.lateFrames) {
                this.stale++;
                this.write({
                    t: "stale",
                    frame: this.frame,
                    reqId: item.reqId,
                    targetFrame: item.targetFrame,
                    lateBy: lateBy
                });
                this.line(frameTag(this.frame) + " stale       " +
                    pad("#" + item.reqId, 5) +
                    " (" + lateBy + "f late)");
                continue;
            }

            const holds = currentFields != null &&
                JevTranslator.premiseHolds(item.askedFields, currentFields);

            if (!holds) {
                this.superseded++;
                this.write({
                    t: "superseded",
                    frame: this.frame,
                    reqId: item.reqId,
                    targetFrame: item.targetFrame,
                    reason: "premise",
                    asked: item.askedFields != null
                        ? { position: item.askedFields.position, motion: item.askedFields.motion }
                        : null,
                    current: currentFields != null
                        ? { position: currentFields.position, motion: currentFields.motion }
                        : null
                });
                this.line(frameTag(this.frame) + " superseded  " +
                    pad("#" + item.reqId, 5) +
                    " (premise)");
                continue;
            }

            this.applied++;
            this.lateByValues.push(Math.abs(lateBy));

            this.write({
                t: "apply",
                frame: this.frame,
                reqId: item.reqId,
                targetFrame: item.targetFrame,
                choice: item.answer.choice,
                lateBy: lateBy
            });
            this.line(frameTag(this.frame) + " apply       " +
                pad("#" + item.reqId, 5) +
                " " + pad(item.answer.choice || "?", 4) + " (" + lateBy + "f late)");

            if (item.answer.choice === FLAP) {
                this.appliedFlap++;
                this.doFlap();
                flapped = true;
            } else {
                this.appliedWait++;
            }
        }

        this.held = keep;
    }

    /* ----------------------------------------------------------- sends */

    maybeSend() {
        if (!this.bird.live) return 0;

        const now = Date.now();
        if (now - this.lastSendMs < this.tickMs) return 0;
        if (!this.client.canSend()) return 0;

        const reqId = this.sendNow(this.leadFrames());

        // a skipped send must not eat the cadence
        if (reqId) this.lastSendMs = now;
        return reqId;
    }

    // One request: one snapshot at the lead, the single `decision` question about
    // it, and a tag that remembers the frame the answer belongs to.
    sendNow(leadFrames) {
        const described = this.describe(leadFrames);
        if (described == null) return 0;

        const leadMs = this.leadMode === "none" ? 0 : Math.round(this.leadMs);
        const sentFrame = this.frame;
        const targetFrame = sentFrame + leadFrames;

        const tag = {
            runId: this.runId,
            reqId: 0,
            sentFrame: sentFrame,
            targetFrame: targetFrame,
            leadFrames: leadFrames,
            askedFields: described.fields
        };

        const reqId = this.client.send(described.state, JevQuestions.build(), tag);
        if (!reqId) return 0;
        tag.reqId = reqId;

        this.leadFramesValues.push(leadFrames);

        this.write({
            t: "send",
            frame: sentFrame,
            reqId: reqId,
            targetFrame: targetFrame,
            leadFrames: leadFrames,
            leadMs: leadMs,
            fields: described.fields,
            actual: {
                birdY: round2(this.bird.pos.y),
                vel: round2(this.bird.velocity),
                pipeX1: this.nextPipe != null ? round2(this.nextPipe.topPipe.x1) : null
            }
        });

        const f = described.fields;

        this.line(frameTag(sentFrame) + " send        " + pad("#" + reqId, 5) +
            " ->" + frameTag(targetFrame) + " (" + leadFrames + "f) " +
            shortPosition(f.position) + " | " + f.motion + " | dist " + f.distance);

        return reqId;
    }

    // Blocks until something lands in the inbox, or until nothing is left in
    // flight to wait for (an errored request never answers).
    async awaitAnswer() {
        while (this.client.inbox.length === 0 && this.client.inFlight > 0) {
            await sleep(2);
        }
    }

    // Before frame 1: describe the opening scene with no lead, hold the world
    // still until the pilot answers, act on it. Nothing moves in here, so a cold
    // first call costs wall clock but no altitude.
    async doWarmStart() {
        this.nextPipe = this.selectNextPipe();

        const startedAt = Date.now();
        const reqId = this.sendNow(0);
        if (!reqId) return;

        this.lastSendMs = Date.now();

        await this.awaitAnswer();
        this.drainAnswers();
        this.applyHeld();

        this.warmStartMs = Date.now() - startedAt;

        if (this.client.stats.answers > 0) {
            this.line("warm start: first answer after " + this.warmStartMs + " ms");
        } else {
            this.line("warm start: no answer after " + this.warmStartMs + " ms, taking off blind");
        }
    }

    // The timeline is real time: one frame every 1000/60 ms, with the deadline
    // carried forward so a slow frame does not shift the whole run.
    async fly() {
        const startedAt = Date.now();

        await this.doWarmStart();

        let deadline = Date.now();

        while (this.frame < this.opts.maxFrames) {
            deadline += FRAME_MS;
            const wait = deadline - Date.now();
            if (wait > 0) await sleep(wait);
            else await Promise.resolve();

            if (!this.step()) break;
        }

        if (this.death == null) {
            this.client.abortAll();
            this.line(frameTag(this.frame) + " END   frame budget reached, score " + this.bird.score);
        }

        return {
            runIndex: this.runIndex,
            seed: this.seed,
            frames: this.frame,
            wallSeconds: (Date.now() - startedAt) / 1000,
            gameSeconds: (this.frame * this.dt) / 60,
            score: this.bird.score,
            cause: this.death != null ? this.death.cause : "survived",
            sent: this.client.stats.requests,
            inputTokens: this.client.stats.inputTokens,
            answered: this.client.stats.answers,
            errors: this.client.stats.errors,
            candidatesHeld: this.candidatesHeld,
            applied: this.applied,
            appliedFlap: this.appliedFlap,
            appliedWait: this.appliedWait,
            superseded: this.superseded,
            stale: this.stale,
            discarded: this.discarded,
            flaps: this.flaps,
            climb: longestClimb(this.birdYs),
            errorLog: this.client.errorLog,
            latenciesMs: this.latenciesMs,
            latenciesFrames: this.latenciesFrames,
            modelMsValues: this.modelMsValues,
            leadFramesValues: this.leadFramesValues,
            lateByValues: this.lateByValues,
            timeScale: this.timeScale,
            leadMode: this.leadMode,
            warmStartMs: this.warmStartMs
        };
    }
}

/* ---------------------------------------------------------------- reports */

function printSummary(label, rows) {
    const latMs = [];
    const latFrames = [];
    const modelMs = [];
    const leadFrames = [];
    const lateBy = [];

    const totals = {
        frames: 0, score: 0, wall: 0, game: 0,
        sent: 0, answered: 0, candidatesHeld: 0,
        applied: 0, appliedFlap: 0, appliedWait: 0,
        superseded: 0, stale: 0, discarded: 0, errors: 0, flaps: 0, inputTokens: 0
    };

    let bestClimb = { rise: 0, frames: 0, fromFrame: 0, toFrame: 0 };

    for (const r of rows) {
        for (const v of r.latenciesMs) latMs.push(v);
        for (const v of r.latenciesFrames) latFrames.push(v);
        for (const v of r.modelMsValues) modelMs.push(v);
        for (const v of r.leadFramesValues) leadFrames.push(v);
        for (const v of r.lateByValues) lateBy.push(v);

        totals.frames += r.frames;
        totals.score += r.score;
        totals.wall += r.wallSeconds;
        totals.game += r.gameSeconds;
        totals.sent += r.sent;
        totals.inputTokens += r.inputTokens || 0;
        totals.answered += r.answered;
        totals.candidatesHeld += r.candidatesHeld;
        totals.applied += r.applied;
        totals.appliedFlap += r.appliedFlap;
        totals.appliedWait += r.appliedWait;
        totals.superseded += r.superseded;
        totals.stale += r.stale;
        totals.discarded += r.discarded;
        totals.errors += r.errors;
        totals.flaps += r.flaps;

        if (r.climb.rise > bestClimb.rise) bestClimb = r.climb;
    }

    const sortedMs = latMs.slice().sort(function (a, b) { return a - b; });
    const timeScale = rows[0].timeScale;

    const warmStarts = rows
        .map(function (r) { return r.warmStartMs; })
        .filter(function (v) { return v != null; });

    const flapsPerGameMinute = totals.game > 0 ? totals.flaps * 60 / totals.game : 0;

    console.log("\n=== " + label + " ===");
    console.log("  lead            : " + rows[0].leadMode +
        ", mean " + mean(leadFrames).toFixed(1) + " frames" +
        (warmStarts.length > 0
            ? " (warm start " + warmStarts.map(function (v) { return v + " ms"; }).join(", ") + ")"
            : ""));
    console.log("  freshness       : by premise");
    console.log("  time scale      : " + timeScale + "x" +
        (timeScale === 1 ? " (game time = wall time)" : " (the world runs " + timeScale + "x slower than wall time)"));
    console.log("  frames survived : " + totals.frames + "  (" + (totals.frames / 60).toFixed(2) +
        " s of draw time, " + totals.game.toFixed(2) + " s of game time, " +
        totals.wall.toFixed(2) + " s of wall clock)");
    console.log("  score           : " + totals.score);
    if (rows.length === 1) {
        console.log("  cause of death  : " + rows[0].cause);
    } else {
        console.log("  cause of death  : " + rows.map(function (r) {
            return "run " + (r.runIndex + 1) + " " + r.cause + " (score " + r.score + ", " + r.frames + "f)";
        }).join("; "));
    }
    console.log("  requests        : " + totals.sent + " sent, " + totals.answered + " answered, " +
        totals.discarded + " discarded" +
        (totals.errors > 0 ? ", " + totals.errors + " errored" : ""));
    console.log("  tokens          : " + totals.inputTokens + " in (" +
        (totals.sent > 0 ? Math.round(totals.inputTokens / totals.sent) : 0) + " per request, " +
        Math.round(totals.inputTokens / Math.max(1, totals.frames / 60 / 60)) + " per minute of wall clock)");
    console.log("  candidates      : " + totals.candidatesHeld + " held, " + totals.applied +
        " applied, " + totals.superseded + " superseded (premise), " + totals.stale + " stale");
    console.log("  decisions       : " + totals.appliedFlap + " FLAP, " + totals.appliedWait +
        " WAIT | " + totals.flaps + " flaps, " + flapsPerGameMinute.toFixed(1) +
        " per minute of game time");
    console.log("  longest climb   : " + Math.round(bestClimb.rise) + " px over " +
        bestClimb.frames + " frames" +
        (bestClimb.rise > 0
            ? " (" + frameTag(bestClimb.fromFrame) + "->" + frameTag(bestClimb.toFrame) + ")"
            : ""));
    console.log("  latency         : mean " + Math.round(mean(latMs)) + " ms, p95 " +
        Math.round(percentile(sortedMs, 0.95)) + " ms, mean " +
        mean(latFrames).toFixed(1) + " frames");
    console.log("  model time      : " + (modelMs.length > 0
        ? "mean " + Math.round(mean(modelMs)) + " ms over " + modelMs.length + " answers"
        : "not reported"));
    console.log("  applied lateness: mean " + mean(lateBy).toFixed(2) + " frames" +
        " (dropped beyond " + rows[0].lateFramesLimit + " frames)");

    const allErrors = [];
    for (const r of rows) {
        for (const e of r.errorLog) allErrors.push(e);
    }
    if (allErrors.length > 0) {
        const shown = allErrors.slice(0, 5);
        console.log("  errors          : " + shown.map(function (e) {
            return "#" + e.reqId + "@f" + e.frame + " " + e.message;
        }).join(" | ") + (allErrors.length > shown.length
            ? " (+" + (allErrors.length - shown.length) + " more)"
            : ""));
    }
}

/* ------------------------------------------------------------------- main */

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.mock) {
        opts.transport = mockTransport(makeRandom(opts.seed ^ 0x5bf03635));
    } else {
        try {
            require("dotenv").config();
        } catch (err) {
            // dotenv is optional here; the key may come from the real environment.
        }

        const apiKey = process.env.TYPESAFE_API_KEY;
        if (!apiKey) {
            console.error("TYPESAFE_API_KEY is not set (put it in .env or the environment).");
            console.error("Run with --mock to fly the simulator without calling the API.");
            process.exit(2);
        }
        opts.transport = realTransport(apiKey);
    }

    const logDir = path.join(os.tmpdir(), "flappy-jev-sim");
    fs.mkdirSync(logDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    console.log("flappy-jev simulator v2.1 | translator v" + JevTranslator.VERSION +
        " | decision " + JevQuestions.FLAP + "/" + JevQuestions.WAIT);
    console.log("canvas " + opts.width + "x" + opts.height +
        " | tick every " + opts.tickMs + " ms" +
        " | max in flight " + opts.maxInFlight +
        " | late window " + opts.lateFrames + " frames" +
        " | time scale " + opts.timeScale + "x" +
        " | budget " + opts.maxFrames + " frames (" + (opts.maxFrames / 60).toFixed(1) + " s)");
    console.log("single `decision` question | freshness by premise");
    console.log("lead " + (opts.leadMode === "none"
        ? "off (--no-lead)"
        : (opts.leadMode === "fixed"
            ? "fixed at " + opts.leadMs + " ms"
            : "EMA, alpha " + LEAD_ALPHA + ", from " + LEAD_INITIAL_MS + " ms")) +
        " | transport " + (opts.mock
            ? "mock, " + MOCK_LATENCY_MS + " +-" + MOCK_JITTER_MS + " ms"
            : "typesafe " + MODEL + ", keep-alive"));

    const rows = [];

    for (let i = 0; i < opts.runs; i++) {
        const seed = opts.seed + i;
        const file = path.join(logDir, "sim-" + stamp + "-" + seed + ".jsonl");
        const trace = fs.createWriteStream(file, { flags: "a" });

        console.log("\nrun " + (i + 1) + "/" + opts.runs + " | seed " + seed);
        console.log("trace " + file);

        const run = new SimRun(opts, seed, i, trace);
        const row = await run.fly();
        row.lateFramesLimit = opts.lateFrames;
        rows.push(row);

        await new Promise(function (resolve) { trace.end(resolve); });

        if (opts.runs > 1) printSummary("run " + (i + 1) + ", seed " + seed, [row]);
    }

    printSummary(opts.runs > 1 ? "overall, " + opts.runs + " runs" : "summary", rows);
    console.log("\ntraces in " + logDir);
}

if (require.main === module) {
    main().catch(function (err) {
        console.error("simulator crashed: " + ((err && err.stack) || err));
        process.exit(2);
    });
}

// exported so the physics port can be exercised on its own
module.exports = {
    Bird: Bird,
    Pipe: Pipe,
    circleRect: circleRect,
    makeRandom: makeRandom,
    longestClimb: longestClimb,
    SimRun: SimRun
};
