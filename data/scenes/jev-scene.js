// Jev flies the bird. The loop never waits for an answer: it keeps running and
// uses whatever came back, so a slow request costs a few frames of staleness
// instead of a freeze. Code only describes the scene, Jev decides.
//
// Jev is not asked "flap right now?" anymore. One hop is worth about 45 px and the
// round trip costs ~17 frames, so a per-frame yes/no could never climb. Jev picks a
// maneuver instead and the scene spends it as a little hop plan.
//
// The debug mode on top of that: a warm start that holds the world still until the
// first answer is in, P/N/M/L to pause, step and lockstep, and a trace log in the
// same JSONL shape the offline harness writes, so a browser flight and a headless
// one can be read side by side.
const JEV_TICK_EVERY = 9;

//the trace is a debugging aid, not a recording; the oldest lines fall off
const JEV_TRACE_MAX = 2000;

//how many frames one M press is allowed to burn before it gives up
const JEV_STEP_BUDGET = 600;

//P N M L, read off keyCode so no other scene ever sees them
const JEV_KEY_PAUSE = 80;
const JEV_KEY_STEP = 78;
const JEV_KEY_NEXT_EVENT = 77;
const JEV_KEY_LOCKSTEP = 76;

//the trace keeps the same two decimals the harness writes, nothing more
function jevRound2(n) {
    return Math.round(n * 100) / 100;
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
        this.client = new JevClient({ endpoint: "/api/jev", maxInFlight: 2, timeoutMs: 4000 });
        this.panel = null;

        this.frame = 0;
        this.runId = 0;
        this.framesSinceFlap = 999;
        this.lastTickFrame = 0;

        //the hop plan: how many flaps are still owed and when the next one is due
        this.hopsRemaining = 0;
        this.nextHopFrame = 0;

        this.lastDescription = null;
        this.lastFields = null;
        this.lastAnswers = null;

        this.abortedOnDeath = false;

        //#region debug mode
        //the warm start: nothing moves until the pilot has answered once
        this.waitingForPilot = false;

        this.paused = false;

        //lockstep is sticky across runs on purpose, it is a mode you switch into
        this.lockstep = false;
        this.lockstepFrozen = false;

        //the trace survives restarts, every run just appends a new header
        this.trace = [];
        this.traceSeq = 0;

        //anything worth stopping M at: a send, a drained answer, a hop, a death
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

        this.bird = new Bird(BIRD_X, height/2);

        //the Pipe constructor pushes into the active scene's pipes, so this must exist first
        this.pipes = [];

        let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);

        for (let i = 1; i <= pipeCount + 2; i++) {
            new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
        }

        this.nextPipe = null;

        this.frame = 0;
        this.runId++;
        this.framesSinceFlap = 999;
        this.lastTickFrame = -JEV_TICK_EVERY;

        this.hopsRemaining = 0;
        this.nextHopFrame = 0;

        this.lastDescription = null;
        this.lastFields = null;
        this.lastAnswers = null;

        this.abortedOnDeath = false;

        this.paused = false;
        this.lockstepFrozen = false;

        this.gameStarted = true;

        this.writeTrace({
            t: "header",
            runId: this.runId,
            lockstep: this.lockstep,
            warmStart: true,
            tick: JEV_TICK_EVERY,
            maxInFlight: this.lockstep ? 1 : this.client.maxInFlight,
            height: height,
            width: width,
            translator: JevTranslator.VERSION
        });

        this.beginWarmStart();
    }

    // Frame 0: describe the opening scene and hold everything still until the
    // answer lands. A cold connection costs 700-850 ms and the bird falls from
    // height/2 to the ground in 46 frames, so taking off blind is taking off dead.
    beginWarmStart() {
        this.waitingForPilot = true;

        this.nextPipe = this.selectNextPipe();
        this.lastDescription = this.buildDescription();
        this.lastFields = this.lastDescription != null ? this.lastDescription.fields : null;

        //the warm start eats the first tick, the answer is fresh on frame 1
        if (this.sendNow()) this.lastTickFrame = this.frame;
    }

    update() {
        super.update();

        if (!this.gameStarted) return;

        if (this.waitingForPilot) {
            this.drainAnswers(); //clears the flag as soon as a plan is in
            if (this.waitingForPilot) this.retryWarmStart();
            return;
        }

        if (this.paused) return;

        //lockstep: the world holds still from the send until the answer is drained
        if (this.lockstepFrozen && this.thawLockstep()) return;

        this.stepFrame();
    }

    //one frame of the flight, the loop body the debug keys borrow
    stepFrame() {
        if (!this.bird.live) {
            //no auto restart, the user clicks when they want another flight
            return;
        }

        this.frame++;

        this.drainAnswers();

        //spend the plan: a hop now, the rest one every HOP_SPACING_FRAMES frames
        if (this.hopsRemaining > 0 && this.frame >= this.nextHopFrame) {
            this.doFlap();
            this.hopsRemaining--;
            this.nextHopFrame = this.frame + JevQuestions.HOP_SPACING_FRAMES;

            this.writeTrace({ t: "hop", frame: this.frame, hopsLeft: this.hopsRemaining });
            this.events++;
        }

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

        this.lastDescription = this.buildDescription();
        this.lastFields = this.lastDescription != null ? this.lastDescription.fields : null;

        if (!this.bird.live) {
            this.noteDeath(cause);
            return;
        }

        this.maybeSend();
    }

    //the only place that flaps
    doFlap() {
        this.bird.jump();
        this.framesSinceFlap = 0;
    }

    clearPlan() {
        this.hopsRemaining = 0;
        this.nextHopFrame = 0;
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
            gapCenter: this.nextPipe != null ? this.nextPipe.pos.y : null,
            pipeX1: this.nextPipe != null ? this.nextPipe.topPipe.x1 : null
        });
        this.events++;

        this.client.abortAll(); //no calls while dead
        this.clearPlan();
        this.lockstepFrozen = false;
    }

    buildDescription() {
        if (this.nextPipe == null) return null;

        let followingPipe = this.pipes[this.pipes.indexOf(this.nextPipe) + 1];

        return JevTranslator.describeScene({
            birdX: this.bird.pos.x,
            birdY: this.bird.pos.y,
            birdVelocity: this.bird.velocity,
            birdRadius: JEV_COLLISION_R,
            framesSinceFlap: this.framesSinceFlap,
            nextPipe: {
                x1: this.nextPipe.topPipe.x1,
                x2: this.nextPipe.topPipe.x2,
                gapCenter: this.nextPipe.pos.y
            },
            followingPipe: followingPipe != null ? { gapCenter: followingPipe.pos.y } : null,
            groundY: height - GROUND_HEIGHT,
            canvasHeight: height
        });
    }

    //returns how many answers were actually applied, the step keys look at that
    drainAnswers() {
        let applied = 0;
        let message = this.client.takeAnswer();
        while (message != null) {
            let tag = message.tag || {};
            //only an answer about a flight that is already over is worthless
            if (tag.runId !== this.runId) {
                this.client.stats.discarded++;
            } else {
                this.lastAnswers = message.answers;

                //a newer answer replaces what is left of the old plan, that is the freshness rule now
                let maneuver = message.answers.maneuver;
                let choice = maneuver != null ? maneuver.choice : null;
                let hops = JevQuestions.HOPS[choice];
                this.hopsRemaining = (typeof hops === "number") ? hops : 0;
                this.nextHopFrame = this.frame; //so the first hop lands this frame

                this.noteAnswer(message, choice);

                applied++;
                //a plan is in: the warm start is over and lockstep may run again
                this.waitingForPilot = false;
                this.lockstepFrozen = false;
            }
            message = this.client.takeAnswer();
        }
        return applied;
    }

    noteAnswer(message, choice) {
        let tag = message.tag || {};
        let maneuver = message.answers.maneuver || {};
        let read = message.answers.read || null;
        let danger = message.answers.danger || null;

        this.writeTrace({
            t: "recv",
            frame: this.frame,
            reqId: message.reqId,
            sentFrame: tag.frame,
            latencyMs: message.latencyMs,
            choice: choice,
            probs: maneuver.probabilities || null,
            danger: (danger != null && danger.score !== undefined) ? danger.score : null,
            read: (read != null && read.choice !== undefined) ? read.choice : null,
            birdY: jevRound2(this.bird.pos.y),
            vel: jevRound2(this.bird.velocity)
        });
        this.events++;
    }

    maybeSend() {
        if (!this.bird.live) return;
        if (this.sceneManager.getActiveScene() !== this) return;
        if (document.visibilityState !== "visible") return;
        if (this.lastDescription == null) return;
        if (this.frame - this.lastTickFrame < JEV_TICK_EVERY) return;
        if (!this.client.canSend()) return;
        //lockstep means one request at a time, no matter what maxInFlight says
        if (this.lockstep && this.client.inFlight > 0) return;

        //a skipped send must not eat the tick
        if (this.sendNow()) this.lastTickFrame = this.frame;
    }

    //the single door out: every request is traced and freezes lockstep here
    sendNow() {
        if (this.lastDescription == null) return 0;

        let reqId = this.client.send(this.lastDescription.state, JevQuestions.build(), {
            runId: this.runId,
            frame: this.frame
        });

        if (!reqId) return 0;

        this.writeTrace({
            t: "send",
            frame: this.frame,
            reqId: reqId,
            state: this.lastFields,
            birdY: jevRound2(this.bird.pos.y),
            vel: jevRound2(this.bird.velocity),
            gapCenter: this.nextPipe != null ? this.nextPipe.pos.y : null,
            pipeX1: this.nextPipe != null ? this.nextPipe.topPipe.x1 : null
        });
        this.events++;

        if (this.lockstep) this.lockstepFrozen = true;

        return reqId;
    }

    // The warm start request failed, so wait out the backoff and ask again.
    // Nothing else is allowed to go out while the pilot is missing.
    retryWarmStart() {
        if (this.client.inFlight > 0) return;
        if (!this.client.canSend()) return;
        if (this.sceneManager.getActiveScene() !== this) return;
        if (document.visibilityState !== "visible") return;

        this.sendNow();
    }

    //#region debug keys
    togglePause() {
        this.paused = !this.paused;
    }

    toggleLockstep() {
        this.lockstep = !this.lockstep;
        //leaving the mode must not leave the world frozen behind
        if (!this.lockstep) this.lockstepFrozen = false;
    }

    // Drain whatever is in, and let the flight go again if there is nothing
    // left to wait for: an errored request never answers and must not freeze
    // the world for good. Returns true while the freeze still holds.
    thawLockstep() {
        this.drainAnswers();

        if (this.lockstepFrozen && this.client.inFlight === 0) this.lockstepFrozen = false;

        return this.lockstepFrozen;
    }

    // N: exactly one frame. While the world is frozen for another reason the
    // only thing that can move is an answer landing, so try that instead.
    manualStep() {
        if (this.bird == null || !this.bird.live) return;

        if (this.waitingForPilot) {
            this.drainAnswers();
            return;
        }

        if (this.lockstepFrozen && this.thawLockstep()) return;

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
            if (this.waitingForPilot || this.lockstepFrozen) return;
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
        else if (this.lockstepFrozen) status = "lockstep";
        else if (document.visibilityState !== "visible") status = "hidden";
        else if (Date.now() < this.client.backoffUntilMs) status = "backoff";

        let answers = this.lastAnswers || {};
        let stats = this.client.stats;

        return {
            status: status,
            fields: this.lastFields,
            maneuver: answers.maneuver || null,
            plan: {
                hopsRemaining: this.hopsRemaining,
                nextHopIn: Math.max(0, this.nextHopFrame - this.frame)
            },
            read: answers.read || null,
            danger: answers.danger || null,
            meta: {
                inFlight: this.client.inFlight + " / " + (this.lockstep ? 1 : this.client.maxInFlight),
                requests: stats.requests + " sent, " + stats.answers + " back",
                tokens: stats.inputTokens + " in, " + stats.outputTokens + " out",
                latency: stats.lastLatencyMs + " ms",
                discarded: stats.discarded,
                errors: stats.errors + (stats.lastError != null ? " (" + stats.lastError + ")" : "")
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
        if (keyCode === JEV_KEY_LOCKSTEP) {
            this.toggleLockstep();
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
        this.lockstepFrozen = false;

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
