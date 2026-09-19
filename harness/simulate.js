"use strict";

/*
 * Headless flight simulator for the Jev pilot.
 *
 * Runs the JevScene loop without p5 and without a browser: a fixed 60 fps
 * timeline, the real physics from data/flappybird/*, the real scene
 * translator, and real asynchronous calls to TypeSafe's System One endpoint.
 * The loop never waits for an answer, exactly like the game: a request is
 * fired, the frames keep ticking, and the answer is drained at the top of
 * whichever frame it happens to arrive on.
 *
 *   node harness/simulate.js [--mock] [--seed=N] [--runs=N] [--max-frames=N]
 *                            [--tick=N] [--max-in-flight=N] [--no-warm-start]
 *                            [--lockstep] [--tick-lockstep=N]
 *                            [--height=N] [--width=N] [--quiet]
 *
 * The pilot is warm started by default: one request describes the opening
 * scene and the world is held still until that answer lands, so a cold first
 * call cannot drop the bird before it has a pilot. --lockstep goes further and
 * freezes the world for every request, which takes latency out of the picture
 * entirely and leaves only the quality of the description under test.
 *
 * --mock swaps the transport for a local fake (380 ms, trivial policy) so the
 * whole pipeline can be exercised without a key.
 *
 * Every run writes a JSONL trace under <os tmpdir>/flappy-jev-sim/ and prints
 * its path.
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

const MOCK_LATENCY_MS = 380;

const MANEUVERS = ["let_it_fall", "one_hop", "two_hops", "climb_hard"];
const SHORT = {
    let_it_fall: "fall",
    one_hop: "1hop",
    two_hops: "2hop",
    climb_hard: "climb"
};

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
    const opts = {
        mock: false,
        quiet: false,
        seed: 1,
        runs: 1,
        maxFrames: 3600,
        tick: 9,
        tickLockstep: null,
        maxInFlight: 2,
        warmStart: true,
        lockstep: false,
        timeScale: 1,
        height: DEFAULT_HEIGHT,
        width: null
    };

    const integers = {
        "--seed": "seed",
        "--runs": "runs",
        "--max-frames": "maxFrames",
        "--tick": "tick",
        "--tick-lockstep": "tickLockstep",
        "--max-in-flight": "maxInFlight",
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
        if (arg === "--no-warm-start") {
            opts.warmStart = false;
            continue;
        }
        if (arg === "--lockstep") {
            opts.lockstep = true;
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
    if (opts.tick < 1) opts.tick = 1;
    if (opts.tickLockstep === null) opts.tickLockstep = opts.tick;
    if (opts.tickLockstep < 1) opts.tickLockstep = 1;
    if (opts.maxInFlight < 1) opts.maxInFlight = 1;
    if (!(opts.timeScale >= 1)) opts.timeScale = 1;
    // a frozen world can only ever have one request outstanding
    if (opts.lockstep) opts.maxInFlight = 1;

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

function signed(n) {
    const r = Math.round(n);
    return (r >= 0 ? "+" : "") + r;
}

function prob(p) {
    const n = Number(p);
    if (!Number.isFinite(n)) return " n/a";
    const text = n.toFixed(2);
    return text.charAt(0) === "0" ? text.slice(1) : text;
}

function formatProbs(probabilities) {
    return "[" + MANEUVERS.map(function (m) {
        return SHORT[m] + " " + prob(probabilities && probabilities[m]);
    }).join(" ") + "]";
}

function round2(n) {
    return Math.round(n * 100) / 100;
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

function realTransport(apiKey) {
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
            signal: signal
        });

        if (!response.ok) {
            let detail = "";
            try {
                detail = (await response.text()).slice(0, 200);
            } catch (err) {
                detail = "";
            }
            throw new Error("http " + response.status + " " + detail);
        }

        return response.json();
    };
}

// Trivial but plausible stand-in: read the two phrases a human would read
// first and pick the obvious maneuver. The ground/ceiling guard comes before
// the gap, otherwise "far above the opening" flies the bird into the floor
// while the answer is still in the air.
function mockChoice(place, around, motion) {
    // a flap zeroes the velocity, so one hop is enough to arrest a dive
    const falling = motion === "starting to fall" ||
        motion === "falling" ||
        motion === "dropping fast";

    if (around.indexOf("ground is close") !== -1) return "climb_hard";
    if (around.indexOf("ceiling is close") !== -1) return "let_it_fall";
    if (place.indexOf("below") !== -1) return "climb_hard";
    // above, or in the middle: fall only while the fall has not started, the
    // round trip is far too slow to recover from a free fall that is already
    // under way
    return falling ? "one_hop" : "let_it_fall";
}

function mockDistribution(choice) {
    const dist = {};
    for (const m of MANEUVERS) dist[m] = 0.13;
    dist[choice] = 0.61;
    return dist;
}

function mockTransport() {
    return function (state, questions, signal) {
        return new Promise(function (resolve, reject) {
            function onAbort() {
                clearTimeout(timer);
                reject(new Error("aborted"));
            }

            const timer = setTimeout(function () {
                if (signal != null) signal.removeEventListener("abort", onAbort);

                const bird = (state && state.bird) || {};
                const place = String(bird.place_in_gap || "");
                const around = String(bird.surroundings || "");
                const motion = String(bird.vertical_motion || "");
                const choice = mockChoice(place, around, motion);

                let read = "aligned";
                if (around.indexOf("ground is close") !== -1) read = "ground_danger";
                else if (around.indexOf("ceiling is close") !== -1) read = "ceiling_danger";
                else if (place.indexOf("below") !== -1) read = "too_low";
                else if (place.indexOf("above") !== -1) read = "too_high";

                resolve({
                    answers: {
                        maneuver: { choice: choice, probabilities: mockDistribution(choice) },
                        read: { choice: read, probabilities: null },
                        danger: {
                            score: read === "aligned" ? 0.25 : (choice === "climb_hard" ? 0.9 : 0.6),
                            legend: "mock"
                        }
                    },
                    usage: { input_tokens: 0, output_tokens: 0 }
                });
            }, MOCK_LATENCY_MS);

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
            discarded: 0,
            inputTokens: 0,
            outputTokens: 0,
            lastLatencyMs: 0,
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
            .then(function (body) {
                if (body == null || body.answers == null) throw new Error("no answers in the response");

                const usage = body.usage || {};
                const latencyMs = Date.now() - startedAt;

                self.inbox.push({
                    reqId: reqId,
                    tag: tag,
                    answers: body.answers,
                    usage: usage,
                    latencyMs: latencyMs
                });

                self.stats.answers++;
                self.stats.inputTokens += usage.input_tokens || 0;
                self.stats.outputTokens += usage.output_tokens || 0;
                self.stats.lastLatencyMs = latencyMs;

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
        this.errorLog.push({ reqId: reqId, frame: tag != null ? tag.frame : null, message: message });

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

        this.lockstep = opts.lockstep === true;
        // slow game time: the world runs timeScale times slower, cadence stays in game time
        this.timeScale = opts.timeScale;
        this.dt = 1 / this.timeScale;
        this.tick = (this.lockstep ? opts.tickLockstep : opts.tick) * this.timeScale;

        this.frame = 0;
        this.runId = runIndex + 1;
        this.framesSinceFlap = 999;
        this.lastTickFrame = -this.tick;

        this.hopsRemaining = 0;
        this.nextHopFrame = 0;

        this.lastDescription = null;
        this.lastFields = null;

        // bookkeeping the game itself does not need
        this.hops = 0;
        this.flips = 0;
        this.lastChoice = null;
        this.latenciesMs = [];
        this.latenciesFrames = [];
        this.death = null;
        this.sentThisFrame = 0;
        this.warmStartMs = null;

        this.write({
            t: "header",
            seed: seed,
            runId: this.runId,
            lockstep: this.lockstep,
            warmStart: opts.warmStart === true,
            tick: this.tick,
            timeScale: this.timeScale,
            maxInFlight: opts.maxInFlight,
            maxFrames: opts.maxFrames,
            height: this.height,
            width: this.width,
            translator: JevTranslator.VERSION
        });
    }

    line(text) {
        if (!this.opts.quiet) console.log(text);
    }

    write(record) {
        this.trace.write(JSON.stringify(record) + "\n");
    }

    pipeOffset() {
        if (this.nextPipe == null) return 0;
        return this.nextPipe.topPipe.x1 - this.bird.pos.x;
    }

    gapCenter() {
        return this.nextPipe != null ? this.nextPipe.pos.y : null;
    }

    // One tick of JevScene.update(), minus the browser-only guards.
    // Returns false once the flight is over.
    step() {
        this.frame++;

        if (!this.bird.live) return false;

        this.drainAnswers();

        // spend the plan: a hop now, the rest one every HOP_SPACING_FRAMES frames
        if (this.hopsRemaining > 0 && this.frame >= this.nextHopFrame) {
            this.bird.jump();
            this.framesSinceFlap = 0;
            this.hopsRemaining--;
            this.nextHopFrame = this.frame + JevQuestions.HOP_SPACING_FRAMES * this.timeScale;
            this.hops++;

            this.write({ t: "hop", frame: this.frame, hopsLeft: this.hopsRemaining });
            this.line(frameTag(this.frame) + " hop  (" + this.hopsRemaining + " left)");
        }

        this.framesSinceFlap++;

        const dt = this.dt;
        this.pipes.forEach(function (pipe) {
            pipe.update(dt);
        });

        this.bird.update(this.height, this.dt);

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

        this.lastDescription = this.buildDescription();
        this.lastFields = this.lastDescription != null ? this.lastDescription.fields : null;

        if (!this.bird.live) {
            this.noteDeath(cause);
            return false;
        }

        this.sentThisFrame = this.maybeSend();
        return true;
    }

    noteDeath(cause) {
        const gap = this.gapCenter();
        const pipeX1 = this.nextPipe != null ? this.nextPipe.topPipe.x1 : null;

        this.death = { frame: this.frame, cause: cause, score: this.bird.score };

        this.write({
            t: "death",
            frame: this.frame,
            cause: cause,
            score: this.bird.score,
            birdY: round2(this.bird.pos.y),
            gapCenter: gap,
            pipeX1: pipeX1
        });

        this.line(frameTag(this.frame) + " DEATH " + pad(cause, 7) +
            " score " + this.bird.score +
            "  y=" + Math.round(this.bird.pos.y) +
            " gap=" + (gap == null ? "-" : Math.round(gap)) +
            " pipe=" + signed(this.pipeOffset()));

        // the scene aborts every call the frame after the bird dies
        this.client.abortAll();
        this.hopsRemaining = 0;
        this.nextHopFrame = 0;
    }

    // same selecting criterion as the watch scene
    selectNextPipe() {
        return this.pipes.filter(function (pipe) {
            return pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R);
        })[0];
    }

    buildDescription() {
        if (this.nextPipe == null) return null;

        const followingPipe = this.pipes[this.pipes.indexOf(this.nextPipe) + 1];

        return JevTranslator.describeScene({
            birdX: this.bird.pos.x,
            birdY: this.bird.pos.y,
            birdVelocity: this.bird.velocity,
            birdRadius: JEV_COLLISION_R,
            framesSinceFlap: this.framesSinceFlap / this.timeScale,
            nextPipe: {
                x1: this.nextPipe.topPipe.x1,
                x2: this.nextPipe.topPipe.x2,
                gapCenter: this.nextPipe.pos.y
            },
            followingPipe: followingPipe != null ? { gapCenter: followingPipe.pos.y } : null,
            groundY: this.height - GROUND_HEIGHT,
            canvasHeight: this.height
        });
    }

    drainAnswers() {
        let message = this.client.takeAnswer();
        while (message != null) {
            const tag = message.tag || {};

            // only an answer about a flight that is already over is worthless
            if (tag.runId !== this.runId) {
                this.client.stats.discarded++;
            } else {
                const maneuver = message.answers.maneuver;
                const choice = maneuver != null ? maneuver.choice : null;
                const hops = JevQuestions.HOPS[choice];
                this.hopsRemaining = (typeof hops === "number") ? hops : 0;
                this.nextHopFrame = this.frame; // so the first hop lands this frame

                this.noteAnswer(message, choice);
            }

            message = this.client.takeAnswer();
        }
    }

    noteAnswer(message, choice) {
        const sentFrame = message.tag.frame;
        const latencyFrames = this.frame - sentFrame;
        const maneuver = message.answers.maneuver || {};
        const probabilities = maneuver.probabilities || null;
        const read = message.answers.read || null;
        const danger = message.answers.danger || null;

        const readChoice = (read != null && read.choice !== undefined) ? read.choice : null;
        const dangerScore = (danger != null && danger.score !== undefined) ? danger.score : null;

        this.latenciesMs.push(message.latencyMs);
        this.latenciesFrames.push(latencyFrames);

        if (this.lastChoice !== null && choice !== this.lastChoice) this.flips++;
        this.lastChoice = choice;

        this.write({
            t: "recv",
            frame: this.frame,
            reqId: message.reqId,
            sentFrame: sentFrame,
            latencyMs: message.latencyMs,
            choice: choice,
            probs: probabilities,
            danger: dangerScore,
            read: readChoice,
            birdY: round2(this.bird.pos.y),
            vel: round2(this.bird.velocity)
        });

        const p = (probabilities != null && choice != null) ? probabilities[choice] : null;

        this.line(frameTag(this.frame) + " recv " + pad("#" + message.reqId, 4) +
            " (" + padLeft(latencyFrames, 2) + "f, " + padLeft(message.latencyMs, 4) + "ms)" +
            " -> " + pad(choice || "?", 12) + prob(p) +
            "  " + formatProbs(probabilities) +
            "  danger " + (dangerScore == null ? "-   " : Number(dangerScore).toFixed(2)) +
            "  read " + pad(readChoice || "-", 10) +
            " y=" + Math.round(this.bird.pos.y) +
            " v=" + this.bird.velocity.toFixed(1));
    }

    maybeSend() {
        if (!this.bird.live) return 0;
        if (this.lastDescription == null) return 0;
        if (this.frame - this.lastTickFrame < this.tick) return 0;
        if (!this.client.canSend()) return 0;

        const reqId = this.sendNow();

        // a skipped send must not eat the tick
        if (reqId) this.lastTickFrame = this.frame;
        return reqId;
    }

    sendNow() {
        const reqId = this.client.send(this.lastDescription.state, JevQuestions.build(), {
            runId: this.runId,
            frame: this.frame
        });

        if (!reqId) return 0;

        const fields = this.lastFields;
        const gap = this.gapCenter();

        this.write({
            t: "send",
            frame: this.frame,
            reqId: reqId,
            state: fields,
            birdY: round2(this.bird.pos.y),
            vel: round2(this.bird.velocity),
            gapCenter: gap,
            pipeX1: this.nextPipe != null ? this.nextPipe.topPipe.x1 : null
        });

        this.line(frameTag(this.frame) + " send " + pad("#" + reqId, 4) +
            " y=" + padLeft(Math.round(this.bird.pos.y), 3) +
            " v=" + padLeft(this.bird.velocity.toFixed(1), 5) +
            " gap=" + (gap == null ? "-" : Math.round(gap)) +
            " pipe=" + padLeft(signed(this.pipeOffset()), 5) +
            "  " + fields.vertical_motion + " | " + fields.place_in_gap + " | " + fields.distance);

        return reqId;
    }

    // Blocks until something lands in the inbox, or until nothing is left in
    // flight to wait for (an errored request never answers).
    async awaitAnswer() {
        while (this.client.inbox.length === 0 && this.client.inFlight > 0) {
            await sleep(2);
        }
    }

    // Frame 0: describe the opening scene, hold the world still until the
    // pilot answers, apply that answer as the first plan. Nothing moves in
    // here, so a cold first call costs wall clock but no altitude.
    async doWarmStart() {
        this.nextPipe = this.selectNextPipe();
        this.lastDescription = this.buildDescription();
        this.lastFields = this.lastDescription != null ? this.lastDescription.fields : null;

        if (this.lastDescription == null) return;

        const startedAt = Date.now();
        const reqId = this.sendNow();
        if (!reqId) return;

        this.lastTickFrame = this.frame;

        await this.awaitAnswer();
        this.drainAnswers();

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

        if (this.opts.warmStart) await this.doWarmStart();

        let deadline = Date.now();

        while (this.frame < this.opts.maxFrames) {
            deadline += FRAME_MS;
            const wait = deadline - Date.now();
            if (wait > 0) await sleep(wait);
            else await Promise.resolve();

            if (!this.step()) break;

            // lockstep: the world holds still until the answer is back, so the
            // plan is applied on the very next frame and latency costs no
            // altitude at all
            if (this.lockstep && this.sentThisFrame) {
                await this.awaitAnswer();
                this.drainAnswers();
                this.sentThisFrame = 0;
                deadline = Date.now();
            }
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
            score: this.bird.score,
            cause: this.death != null ? this.death.cause : "survived",
            requests: this.client.stats.requests,
            answers: this.client.stats.answers,
            errors: this.client.stats.errors,
            discarded: this.client.stats.discarded,
            errorLog: this.client.errorLog,
            latenciesMs: this.latenciesMs,
            latenciesFrames: this.latenciesFrames,
            hops: this.hops,
            flips: this.flips,
            lockstep: this.lockstep,
            warmStart: this.opts.warmStart === true,
            warmStartMs: this.warmStartMs
        };
    }
}

/* ---------------------------------------------------------------- reports */

function printSummary(label, rows) {
    const latMs = [];
    const latFrames = [];
    const totals = {
        frames: 0, score: 0, requests: 0, answers: 0,
        errors: 0, discarded: 0, hops: 0, flips: 0, wall: 0
    };

    for (const r of rows) {
        for (const v of r.latenciesMs) latMs.push(v);
        for (const v of r.latenciesFrames) latFrames.push(v);
        totals.frames += r.frames;
        totals.score += r.score;
        totals.requests += r.requests;
        totals.answers += r.answers;
        totals.errors += r.errors;
        totals.discarded += r.discarded;
        totals.hops += r.hops;
        totals.flips += r.flips;
        totals.wall += r.wallSeconds;
    }

    const sortedMs = latMs.slice().sort(function (a, b) { return a - b; });
    const sortedFrames = latFrames.slice().sort(function (a, b) { return a - b; });
    const meanFrames = mean(latFrames);
    const spacing = JevQuestions.HOP_SPACING_FRAMES;

    const warmStarts = rows
        .map(function (r) { return r.warmStartMs; })
        .filter(function (v) { return v != null; });

    console.log("\n=== " + label + " ===");
    console.log("  mode            : lockstep: " + (rows[0].lockstep ? "on" : "off") +
        ", warm start: " + (rows[0].warmStart ? "on" : "off") +
        (warmStarts.length > 0
            ? " (first answer after " + warmStarts.map(function (v) { return v + " ms"; }).join(", ") + ")"
            : ""));
    console.log("  frames survived : " + totals.frames + "  (" + (totals.frames / 60).toFixed(2) +
        " s of game time, " + totals.wall.toFixed(2) + " s of wall clock)");
    console.log("  score           : " + totals.score);
    if (rows.length === 1) {
        console.log("  cause of death  : " + rows[0].cause);
    } else {
        console.log("  cause of death  : " + rows.map(function (r) {
            return "run " + (r.runIndex + 1) + " " + r.cause + " (score " + r.score + ", " + r.frames + "f)";
        }).join("; "));
    }
    console.log("  requests        : " + totals.requests + " sent, " + totals.answers + " answered, " +
        totals.errors + " errored, " + totals.discarded + " discarded");
    console.log("  latency         : mean " + Math.round(mean(latMs)) + " ms, p95 " +
        Math.round(percentile(sortedMs, 0.95)) + " ms");
    console.log("                    mean " + meanFrames.toFixed(1) + " frames, p95 " +
        percentile(sortedFrames, 0.95) + " frames");
    console.log("  hops executed   : " + totals.hops);
    console.log("  choice flips    : " + totals.flips + " of " +
        Math.max(0, totals.answers - rows.length) + " possible");
    if (rows[0].lockstep) {
        console.log("  staleness       : none, the world is frozen while a request is in flight" +
            " (hop spacing " + spacing + " frames)");
    } else {
        console.log("  staleness       : " + meanFrames.toFixed(1) + " frames of latency against the " +
            spacing + "-frame hop spacing (" + (meanFrames / spacing).toFixed(2) + "x)");
    }

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
        opts.transport = mockTransport();
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

    console.log("flappy-jev simulator | translator v" + JevTranslator.VERSION +
        " | hops " + JSON.stringify(JevQuestions.HOPS) +
        " | hop spacing " + JevQuestions.HOP_SPACING_FRAMES + " frames");
    console.log("canvas " + opts.width + "x" + opts.height +
        " | tick every " + opts.tick + " frames" +
        " | max in flight " + opts.maxInFlight +
        " | budget " + opts.maxFrames + " frames (" + (opts.maxFrames / 60).toFixed(1) + " s)" +
        " | transport " + (opts.mock ? "mock, " + MOCK_LATENCY_MS + " ms" : "typesafe " + MODEL));
    console.log("warm start " + (opts.warmStart ? "on" : "off") +
        " | lockstep " + (opts.lockstep ? "on, tick every " + opts.tickLockstep + " frames" : "off"));

    const rows = [];

    for (let i = 0; i < opts.runs; i++) {
        const seed = opts.seed + i;
        const file = path.join(logDir, "sim-" + stamp + "-" + seed + ".jsonl");
        const trace = fs.createWriteStream(file, { flags: "a" });

        console.log("\nrun " + (i + 1) + "/" + opts.runs + " | seed " + seed);
        console.log("trace " + file);

        const run = new SimRun(opts, seed, i, trace);
        const row = await run.fly();
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
module.exports = { Bird: Bird, Pipe: Pipe, circleRect: circleRect, makeRandom: makeRandom, SimRun: SimRun };
