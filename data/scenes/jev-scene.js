// Jev flies the bird. The loop never waits for an answer: it keeps running and
// uses whatever came back, so a slow request costs a few frames of staleness
// instead of a freeze. Code only describes the scene, Jev decides.
//
// v2 is a straight question again: FLAP or WAIT. That only works because the scene
// no longer asks about now, it asks about later. The round trip is 350-650 ms, so
// every request describes the world as it will be when the answer lands (the bird
// left alone, the pipes scrolled on) and the answer carries the frame it belongs to.
// It is applied on that frame, not on arrival.
//
// The cadence is wall clock, not frame based: one request every JEV_TICK_MS with up
// to JEV_MAX_IN_FLIGHT of them in the air. Answers overtake each other all the time,
// which is fine: every answer remembers the words it was asked about, and on the frame
// it belongs to we check whether those words still describe the bird. They do -> spend it,
// they do not -> the world moved on under it and it goes in the bin. A flap no longer
// wipes everything in the air, so a climb can spend more than one answer per round trip.
//
// v2.1 also asks twice per request: the same flight at the expected arrival ("now") and
// a little after it ("later"), so latency jitter has a second frame to land on.
//
// Slow game time is still here: the jev world advances by a fraction of a frame per
// draw, so the same 60 fps drawing costs Jev fewer game frames per round trip.
const JEV_TIME_SCALE = 4; // the jev world runs this many times slower than the other scenes

//one draw frame is worth this much game time
const JEV_DT = 1 / JEV_TIME_SCALE;

//#region loop constants
//the cadence is wall clock: one request every this many ms, however fast the frames go
const JEV_TICK_MS = 100;

//how many requests may be in the air at once
const JEV_MAX_IN_FLIGHT = 8;

//an answer that missed its frame by more than this is thrown away instead of applied
const JEV_LATE_FRAMES = 6;

//the second horizon sits this many frames behind the first, so a late answer still fits
const JEV_HORIZON_GAP_FRAMES = 8;

//the lead is an EMA of the measured latency, so a slow network widens the prediction
const JEV_LEAD_ALPHA = 0.3;
const JEV_LEAD_START_MS = 400;

//draw frames are 60 fps: the lead is measured in ms and spent in frames
const JEV_FRAME_MS = 1000 / 60; // starting guess, the scene measures the real frame time
//#endregion

//the trace is a debugging aid, not a recording; the oldest lines fall off
const JEV_TRACE_MAX = 2000;

//how many frames one M press is allowed to burn before it gives up
const JEV_STEP_BUDGET = 600;

//P N M, read off keyCode so no other scene ever sees them
const JEV_KEY_PAUSE = 80;
const JEV_KEY_STEP = 78;
const JEV_KEY_NEXT_EVENT = 77;

//the trace keeps the same two decimals the harness writes, nothing more
function jevRound2(n) {
    return Math.round(n * 100) / 100;
}

//one clock for the cadence; a browser without performance.now() still works
function jevNow() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

class JevScene extends Scene {
    constructor() {
        super();
        this.bird;
        this.pipes;

        this.gameStarted = false;

        this.nextPipe = null;

        this.returnToMenuButton;

        // the client outlives a single run so the token counters are per session
        this.client = new JevClient({ endpoint: "/api/jev", maxInFlight: JEV_MAX_IN_FLIGHT, timeoutMs: 4000 });
        this.panel = null;

        this.frame = 0;
        this.runId = 0;

        this.framesSinceFlap = 999;

        //wall clock of the last request that actually went out
        this.lastSendMs = 0;

        //the lead survives a restart, it is a property of the network and not of the flight
        this.leadMs = JEV_LEAD_START_MS;

        //candidates (one per horizon per answer) that are waiting for their frame
        this.held = [];

        //what the panel shows: the last description we sent and the last answer we spent
        this.lastSentFields = null;
        this.lastSentLead = 0;
        this.lastApplied = null;

        this.abortedOnDeath = false;

        //#region debug mode
        //the warm start: nothing moves until the pilot has answered once
        this.waitingForPilot = false;

        this.paused = false;

        //the trace survives restarts, every run just appends a new header
        this.trace = [];
        this.traceSeq = 0;

        //anything worth stopping M at: a send, a drained answer, an apply, a flap, a death
        this.events = 0;
        //#endregion
    }

    setupUI() {
        if (this.panel == null) {
            this.panel = new JevPanel(() => {
                let canvas = document.querySelector("canvas");
                return canvas != null ? canvas.getBoundingClientRect() : null;
            }, () => this.traceFile());
        }

        if (this.returnToMenuButton != null) return;

        this.returnToMenuButton = createButton('<');
        this.returnToMenuButton.addClass("return-to-menu-button");
        let bottomLeftCorner = createVector();
        this.returnToMenuButton.size(30, 30);
        bottomLeftCorner.x = innerWidth/2 - width/2 + 10;
        bottomLeftCorner.y = innerHeight - (innerHeight - height)/2 - 40;
        this.returnToMenuButton.position(bottomLeftCorner.x, bottomLeftCorner.y);
        this.returnToMenuButton.mouseClicked(() => {
            this.sceneManager.openScene(MENU_SCENE);
            //exit() already cleared it, so only remove it if it is still around
            if (this.returnToMenuButton != null) {
                this.returnToMenuButton.remove(); //to pervent any bug
                this.returnToMenuButton = null;
            }
        });
    }

    start() {
        super.start();

        this.setupUI();

        this.bird = new JevBird(BIRD_X, height/2);

        //the Pipe constructor pushes into the active scene's pipes, so this must exist first
        this.pipes = [];

        let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);

        for (let i = 1; i <= pipeCount + 2; i++) {
            new JevPipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
        }

        this.nextPipe = null;

        this.frame = 0;
        this.runId++;
        this.framesSinceFlap = 999;

        this.held = [];
        this.lastSentFields = null;
        this.lastSentLead = 0;
        this.lastApplied = null;

        this.abortedOnDeath = false;

        this.paused = false;

        this.gameStarted = true;

        this.writeTrace({
            t: "header",
            version: 2,
            runId: this.runId,
            tickMs: JEV_TICK_MS,
            maxInFlight: JEV_MAX_IN_FLIGHT,
            lateFrames: JEV_LATE_FRAMES,
            horizonGapFrames: JEV_HORIZON_GAP_FRAMES,
            timeScale: JEV_TIME_SCALE,
            translator: JevTranslator.VERSION
        });

        this.beginWarmStart();
    }

    // Frame 0: describe the opening scene and hold everything still until the
    // answer lands. A cold connection costs 700-850 ms and the bird falls from
    // height/2 to the ground in a few dozen frames, so taking off blind is taking
    // off dead. The warm start asks about now (lead 0), because a frozen world is
    // not going anywhere and predicting it forward would only be a lie. It still asks both
    // horizons, only with the gap closed, so there is one code path out of here.
    beginWarmStart() {
        this.waitingForPilot = true;

        this.nextPipe = this.selectNextPipe();

        if (this.sendNow(0, 0)) this.lastSendMs = jevNow();
    }

    update() {
        super.update();

        if (!this.gameStarted) return;

        if (this.waitingForPilot) {
            this.drainAnswers();
            //a first answer ends the warm start, whatever it says
            if (this.applyHeld() > 0) this.waitingForPilot = false;
            if (this.waitingForPilot) this.retryWarmStart();
            return;
        }

        if (this.paused) return;

        this.stepFrame();
    }

    //one frame of the flight, the loop body the debug keys borrow
    stepFrame() {
        if (!this.bird.live) {
            //no auto restart, the user clicks when they want another flight
            return;
        }

        this.frame++;
        this.noteFrameTime();

        this.drainAnswers();
        this.applyHeld();

        this.framesSinceFlap++;

        this.pipes.forEach(pipe => {
            pipe.update();
        });

        this.bird.update();

        //same selecting criterion as the watch scene
        this.nextPipe = this.selectNextPipe();

        //pipe beats ground beats ceiling, the first one that got him is the cause
        let cause = null;

        if (this.nextPipe != null) {
            // kill the bird if it hit a pipe
            let hitted = circleRect(this.bird, this.nextPipe.topPipe) || circleRect(this.bird, this.nextPipe.bottomPipe);
            if (hitted) {
                this.bird.live = false;
                cause = "pipe";
            }

            // give a point if it passed a pipe
            if (this.bird.pos.x > this.nextPipe.pos.x && this.nextPipe.hasPoint) {
                this.bird.score++;
                this.nextPipe.hasPoint = false;
            }
        }

        // the ground
        if (this.bird.pos.y > height - GROUND_HEIGHT) {
            this.bird.live = false;
            if (cause == null) cause = "ground";
        }

        // the ceiling too, so the rules we tell Jev are actually true
        if (this.bird.pos.y - JEV_COLLISION_R <= 0) {
            this.bird.live = false;
            if (cause == null) cause = "ceiling";
        }

        if (!this.bird.live) {
            this.noteDeath(cause);
            return;
        }

        this.maybeSend();
    }

    //the only place that flaps; everything still held is judged on its own premise later
    doFlap() {
        this.bird.jump();
        this.framesSinceFlap = 0;

        this.writeTrace({ t: "flap", frame: this.frame });
        this.events++;
    }

    selectNextPipe() {
        return this.pipes.filter(pipe => pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R))[0];
    }

    noteDeath(cause) {
        if (this.abortedOnDeath) return;
        this.abortedOnDeath = true;

        this.writeTrace({
            t: "death",
            frame: this.frame,
            cause: cause,
            score: this.bird.score,
            birdY: jevRound2(this.bird.pos.y),
            gapTop: this.nextPipe != null ? jevRound2(this.nextPipe.topPipe.y2) : null,
            gapBottom: this.nextPipe != null ? jevRound2(this.nextPipe.bottomPipe.y1) : null,
            pipeX1: this.nextPipe != null ? jevRound2(this.nextPipe.topPipe.x1) : null
        });
        this.events++;

        this.client.abortAll(); //no calls while dead
        this.held = [];
    }

    //#region asking
    //everything the translator needs, straight off the world; it picks the pipe itself
    buildInput() {
        return {
            birdX: this.bird.pos.x,
            birdY: this.bird.pos.y,
            birdVelocity: this.bird.velocity,
            birdRadius: JEV_COLLISION_R,
            groundY: height - GROUND_HEIGHT,
            pipes: this.pipes.map(pipe => ({
                x1: pipe.topPipe.x1,
                x2: pipe.topPipe.x2,
                gapTop: pipe.topPipe.y2,
                gapBottom: pipe.bottomPipe.y1
            }))
        };
    }

    //how far ahead the answer to a request sent right now will land, in real frames.
    //the frame time is measured (p5 deltaTime) so a fast or slow display does not
    //turn the lead into the wrong number of frames
    leadFrames() {
        return Math.round(this.leadMs / (this.frameMs || JEV_FRAME_MS));
    }

    noteFrameTime() {
        let dt = (typeof deltaTime === "number" && deltaTime > 4 && deltaTime < 100) ? deltaTime : JEV_FRAME_MS;
        this.frameMs = this.frameMs ? this.frameMs * 0.9 + dt * 0.1 : dt;
    }

    maybeSend() {
        if (!this.bird.live) return;
        if (this.sceneManager.getActiveScene() !== this) return;
        if (document.visibilityState !== "visible") return;
        if (jevNow() - this.lastSendMs < JEV_TICK_MS) return;
        if (this.client.inFlight >= JEV_MAX_IN_FLIGHT) return;
        if (!this.client.canSend()) return;

        //a skipped send must not eat the tick
        if (this.sendNow(this.leadFrames(), JEV_HORIZON_GAP_FRAMES)) this.lastSendMs = jevNow();
    }

    // The single door out: every request is described, tagged and traced here. One send
    // carries two snapshots of the same flight, `now` at the lead and `later` a gap behind
    // it, and one question per snapshot. The tag remembers, per horizon, the frame the
    // answer belongs to and the words it was asked about.
    sendNow(leadFrames, gapFrames) {
        let leads = [
            { key: "now", frames: leadFrames },
            { key: "later", frames: leadFrames + (gapFrames || 0) }
        ];

        let description = JevTranslator.describeHorizons(this.buildInput(), leads, JEV_DT);
        if (description == null) return 0;

        let asked = {};
        description.snapshots.forEach(snapshot => {
            asked[snapshot.key] = {
                targetFrame: this.frame + snapshot.frames,
                leadFrames: snapshot.frames,
                fields: snapshot.fields
            };
        });

        let reqId = this.client.send(description.state, JevQuestions.build(JevQuestions.HORIZONS), {
            runId: this.runId,
            sentFrame: this.frame,
            asked: asked
        });

        if (!reqId) return 0;

        //the panel shows the near snapshot, that is the one the lead was aimed at
        this.lastSentFields = asked.now.fields;
        this.lastSentLead = leadFrames;

        this.writeTrace({
            t: "send",
            frame: this.frame,
            reqId: reqId,
            targetFrame: asked.now.targetFrame,
            laterFrame: asked.later.targetFrame,
            leadFrames: leadFrames,
            leadMs: Math.round(this.leadMs),
            fields: asked.now.fields,
            actual: {
                birdY: jevRound2(this.bird.pos.y),
                vel: jevRound2(this.bird.velocity),
                pipeX1: this.nextPipe != null ? jevRound2(this.nextPipe.topPipe.x1) : null
            }
        });
        this.events++;

        return reqId;
    }

    // The warm start request failed, so wait out the backoff and ask again.
    // Nothing else is allowed to go out while the pilot is missing.
    retryWarmStart() {
        if (this.client.inFlight > 0) return;
        if (!this.client.canSend()) return;
        if (this.sceneManager.getActiveScene() !== this) return;
        if (document.visibilityState !== "visible") return;

        this.sendNow(0, 0);
    }
    //#endregion

    //#region answering
    // Empty the inbox. An answer is measured first (it teaches the lead), then split into
    // one candidate per horizon. Each candidate waits for its own frame and is judged there
    // on its own premise, so nothing is decided here.
    drainAnswers() {
        let message = this.client.takeAnswer();
        while (message != null) {
            let tag = message.tag || {};

            //every answer measures the network, even the ones we throw away
            this.leadMs = this.leadMs + JEV_LEAD_ALPHA * (message.latencyMs - this.leadMs);

            let answers = message.answers || {};
            let asked = tag.asked || {};
            let choices = {};
            let outcome;

            if (tag.runId !== this.runId) {
                outcome = "discarded";
                this.client.stats.discarded++;
            } else {
                outcome = "held";
                Object.keys(asked).forEach(key => {
                    let answer = answers[key] || {};
                    choices[key] = answer.choice != null ? answer.choice : null;

                    this.client.stats.held++;
                    this.held.push({
                        reqId: message.reqId,
                        key: key,
                        targetFrame: asked[key].targetFrame,
                        askedFields: asked[key].fields,
                        choice: answer.choice,
                        confidence: answer.confidence,
                        probabilities: answer.probabilities
                    });
                });
            }

            this.writeTrace({
                t: "recv",
                frame: this.frame,
                reqId: message.reqId,
                latencyMs: message.latencyMs,
                choices: choices,
                outcome: outcome
            });
            this.events++;

            message = this.client.takeAnswer();
        }
    }

    //the words the world is in right now: what every due candidate is checked against
    currentFields() {
        let description = JevTranslator.describeScene(this.buildInput(), 0, JEV_DT);
        return description != null ? description.fields : null;
    }

    // Spend whatever is due this frame, oldest target first. A candidate is spent when the
    // words it was asked about still describe the bird; otherwise the world moved on under
    // it and it counts as superseded. One frame never flaps twice: after a flap the rest of
    // this frame's candidates go back on the pile and get a fresh look next frame, where the
    // premise check usually rejects them on its own because the bird is rising now.
    // Returns how many candidates were applied; the warm start and the step keys read that.
    applyHeld() {
        if (this.held.length === 0) return 0;

        this.held.sort((a, b) => a.targetFrame - b.targetFrame);

        let applied = 0;
        let flapped = false;
        let deferred = [];

        //one describeScene per frame is plenty, the world only moves in stepFrame()
        let current = null;
        let haveCurrent = false;

        while (this.held.length > 0) {
            let candidate = this.held[0];
            if (candidate.targetFrame > this.frame) break;

            this.held.shift();

            let lateBy = this.frame - candidate.targetFrame;

            //too late to be about this bird any more
            if (lateBy > JEV_LATE_FRAMES) {
                this.client.stats.stale++;
                this.writeTrace({
                    t: "stale",
                    frame: this.frame,
                    reqId: candidate.reqId,
                    key: candidate.key,
                    targetFrame: candidate.targetFrame
                });
                this.events++;
                continue;
            }

            //a flap already landed this frame, this one gets a fresh look on the next
            if (flapped) {
                deferred.push(candidate);
                continue;
            }

            if (!haveCurrent) {
                current = this.currentFields();
                haveCurrent = true;
            }

            if (current == null || !JevTranslator.premiseHolds(candidate.askedFields, current)) {
                this.client.stats.superseded++;
                this.writeTrace({
                    t: "superseded",
                    frame: this.frame,
                    reqId: candidate.reqId,
                    key: candidate.key,
                    targetFrame: candidate.targetFrame,
                    reason: "premise",
                    asked: candidate.askedFields,
                    now: current
                });
                this.events++;
                continue;
            }

            this.client.stats.applied++;
            applied++;
            this.lastApplied = {
                reqId: candidate.reqId,
                key: candidate.key,
                choice: candidate.choice,
                confidence: candidate.confidence,
                probabilities: candidate.probabilities,
                lateBy: lateBy
            };

            this.writeTrace({
                t: "apply",
                frame: this.frame,
                reqId: candidate.reqId,
                key: candidate.key,
                targetFrame: candidate.targetFrame,
                choice: candidate.choice,
                lateBy: lateBy
            });
            this.events++;

            //WAIT costs nothing, FLAP moves the bird and closes this frame for flapping
            if (candidate.choice === JevQuestions.FLAP) {
                this.doFlap();
                flapped = true;
            }
        }

        if (deferred.length > 0) this.held = deferred.concat(this.held);

        return applied;
    }
    //#endregion

    //#region debug keys
    togglePause() {
        this.paused = !this.paused;
    }

    // N: exactly one frame. While the warm start holds the world the only thing
    // that can move is an answer landing, so try that instead.
    manualStep() {
        if (this.bird == null || !this.bird.live) return;

        if (this.waitingForPilot) {
            this.drainAnswers();
            if (this.applyHeld() > 0) this.waitingForPilot = false;
            return;
        }

        this.stepFrame();
    }

    // M: frames until something happens. A send is an event, so this stops at
    // the tick that asks instead of spinning until the answer comes back.
    stepToEvent() {
        let before = this.events;

        for (let i = 0; i < JEV_STEP_BUDGET; i++) {
            this.manualStep();
            if (this.events !== before) return;
            if (this.bird == null || !this.bird.live) return;
            if (this.waitingForPilot) return;
        }
    }
    //#endregion

    //#region trace
    writeTrace(record) {
        this.trace.push(record);
        this.traceSeq++;
        if (this.trace.length > JEV_TRACE_MAX) this.trace.shift();
    }

    traceFile() {
        let lines = this.trace.map(record => JSON.stringify(record)).join("\n");
        let stamp = new Date().toISOString().replace(/[:.]/g, "-");
        return {
            name: "jev-trace-" + this.runId + "-" + stamp + ".jsonl",
            text: lines + (lines.length > 0 ? "\n" : "")
        };
    }
    //#endregion

    buildView() {
        let status = "live";
        if (!this.bird.live) status = "dead";
        else if (this.waitingForPilot) status = "waiting";
        else if (this.paused) status = "paused";
        else if (document.visibilityState !== "visible") status = "hidden";
        else if (Date.now() < this.client.backoffUntilMs) status = "backoff";

        let stats = this.client.stats;
        let applied = this.lastApplied;

        return {
            status: status,
            described: {
                fields: this.lastSentFields,
                leadFrames: this.lastSentLead
            },
            decision: applied != null ? {
                key: applied.key,
                choice: applied.choice,
                confidence: applied.confidence,
                probabilities: applied.probabilities
            } : null,
            lastApplied: applied,
            meta: {
                inFlight: this.client.inFlight + " / " + JEV_MAX_IN_FLIGHT,
                candidates: "held " + this.held.length,
                sent: stats.requests,
                applied: stats.applied,
                superseded: stats.superseded + " (premise)" +
                    (stats.discarded > 0 ? " (+" + stats.discarded + " old run)" : ""),
                stale: stats.stale,
                lead: Math.round(this.leadMs) + " ms (" + this.leadFrames() + "f)",
                latency: stats.lastLatencyMs + " ms, upstream " +
                    (stats.lastUpstreamMs != null ? stats.lastUpstreamMs + " ms" : "-"),
                tokens: stats.inputTokens + " in, " + stats.outputTokens + " out",
                errors: stats.errors + (stats.lastError != null ? " (" + stats.lastError + ")" : ""),
                speed: "1/" + JEV_TIME_SCALE + " (jev world)"
            },
            trace: {
                seq: this.traceSeq,
                entries: this.trace
            }
        };
    }

    draw() {
        background(color(BG_COLOR));

        this.pipes.forEach(pipe => {
            pipe.show();
        });

        //bird after the pipes so it is not hidden by them when dieing
        this.bird.show();

        push(); //Ground drawing
            noStroke();
            fill(color(GROUND_COLOR));
            rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
        pop();

        push(); //Score drawing
            textAlign(CENTER);
            fill(255);
            textSize(60);
            text(this.bird.score, width/2, 60);
        pop();

        if (this.bird.live && this.waitingForPilot) {
            push(); //the bird hangs here until the first answer is in
                textAlign(CENTER);
                fill(255, 255, 255, 200);
                textSize(18);
                text("waiting for pilot", width/2, height/2 - 60);
            pop();
        }

        if (this.bird.live && this.paused) {
            push();
                textAlign(CENTER);
                fill(255, 255, 255, 200);
                textSize(18);
                text("paused", width/2, height/2 - 60);
            pop();
        }

        if (!this.bird.live) {
            push(); //dead panel, nothing happens here until the user clicks
                noStroke();
                fill(0, 0, 0, 255 * 0.70);
                rect(0, 0, width, height);

                textAlign(CENTER);
                fill(255);
                textSize(34);
                text("flight ended", width/2, height/2 - 20);
                textSize(22);
                text("score " + this.bird.score, width/2, height/2 + 14);
                textSize(18);
                text("click to fly again", width/2, height/2 + 48);
            pop();
        }

        if (this.panel != null) this.panel.update(this.buildView());
    }

    //Jev is the pilot, so a click on a live bird does nothing; a dead one restarts
    mouseReleased() {
        if (!this.gameStarted) return;
        if (this.bird == null || this.bird.live) return;
        this.start();
    }

    keyPressed() {
        if (!this.gameStarted) return;

        //the debug keys, only ever read here so no other scene sees them
        if (keyCode === JEV_KEY_PAUSE) {
            this.togglePause();
            return;
        }
        if (this.paused && keyCode === JEV_KEY_STEP) {
            this.manualStep();
            return;
        }
        if (this.paused && keyCode === JEV_KEY_NEXT_EVENT) {
            this.stepToEvent();
            return;
        }

        if (this.bird == null || this.bird.live) return;
        //space or enter, same as a click
        if (keyCode === 32 || keyCode === 13) this.start();
    }

    exit() {
        super.exit();

        this.client.abortAll();

        this.waitingForPilot = false;
        this.paused = false;
        this.held = [];

        if (this.returnToMenuButton != null) {
            this.returnToMenuButton.remove();
            this.returnToMenuButton = null;
        }

        if (this.panel != null) {
            this.panel.destroy();
            this.panel = null;
        }

        this.gameStarted = false;
    }
}

//#region slow world
// The same Bird and the same Pipe, stepped by a fraction of a frame. Only the jev
// scene builds these, every other scene keeps its full frame step, so nothing else
// in the game notices. jump() is untouched: a hop is still worth BIRD_JUMP_POWER.
class JevBird extends Bird {
    update() {
        if (this.pos.y < height - GROUND_HEIGHT) {
            this.pos.y += this.velocity * JEV_DT;
            this.velocity += GRAVITY * JEV_DT;
        } else {
            this.pos.y = height - GROUND_HEIGHT;
        }
    }
}

class JevPipe extends Pipe {
    update() {
        this.pos.x -= this.velocity * JEV_DT;
        if (this.pos.x < -this.width/2){
            sceneManager.getActiveScene().pipes.splice(sceneManager.getActiveScene().pipes.indexOf(this), 1);
            new JevPipe(sceneManager.getActiveScene().pipes[sceneManager.getActiveScene().pipes.length-1].pos.x + PIPE_BETWEEN + PIPE_WIDTH, random(150, height-150));
        }

        this.topPipe = {
            x1: this.pos.x - this.width/2,
            y1: 0,
            x2: this.pos.x + this.width/2,
            y2: this.pos.y - this.gapH/2
        };
        this.bottomPipe = {
            x1: this.pos.x - this.width/2,
            y1: this.pos.y + this.gapH/2,
            x2: this.pos.x + this.width/2,
            y2: height
        };
    }
}
//#endregion
