// Jev flies the bird. The loop never waits for an answer: it keeps running and
// uses whatever came back, so a slow request costs a few frames of staleness
// instead of a freeze. Code only describes the scene, Jev decides.
const JEV_TICK_EVERY = 9;
const JEV_DEATH_HOLD_FRAMES = 90;

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
        this.flapSeq = 0;
        this.framesSinceFlap = 999;
        this.pendingFlap = false;
        this.lastTickFrame = 0;

        this.lastDescription = null;
        this.lastFields = null;
        this.lastAnswers = null;

        this.deadFrames = 0;
        this.abortedOnDeath = false;
    }

    setupUI() {
        if (this.panel == null) {
            this.panel = new JevPanel(() => {
                let canvas = document.querySelector("canvas");
                return canvas != null ? canvas.getBoundingClientRect() : null;
            });
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
        this.flapSeq = 0;
        this.framesSinceFlap = 999;
        this.pendingFlap = false;
        this.lastTickFrame = -JEV_TICK_EVERY;

        this.lastDescription = null;
        this.lastFields = null;
        this.lastAnswers = null;

        this.deadFrames = 0;
        this.abortedOnDeath = false;

        this.gameStarted = true;
    }

    update() {
        super.update();

        if (!this.gameStarted) return;

        this.frame++;

        if (!this.bird.live) {
            if (!this.abortedOnDeath) {
                this.client.abortAll(); //no calls while dead
                this.abortedOnDeath = true;
            }
            this.deadFrames++;
            //restarting lives here and not in draw(), draw() runs for the active scene only by luck
            if (this.deadFrames >= JEV_DEATH_HOLD_FRAMES) this.start();
            return;
        }

        this.drainAnswers();

        if (this.pendingFlap) this.doFlap();

        this.framesSinceFlap++;

        this.pipes.forEach(pipe => {
            pipe.update();
        });

        this.bird.update();

        //same selecting criterion as the watch scene
        this.nextPipe = this.pipes.filter(pipe => pipe.bottomPipe.x1 > BIRD_X - (PIPE_WIDTH + BIRD_R))[0];

        if (this.nextPipe != null) {
            // kill the bird if it hit a pipe
            let hitted = circleRect(this.bird, this.nextPipe.topPipe) || circleRect(this.bird, this.nextPipe.bottomPipe);
            if (hitted) this.bird.live = false;

            // give a point if it passed a pipe
            if (this.bird.pos.x > this.nextPipe.pos.x && this.nextPipe.hasPoint) {
                this.bird.score++;
                this.nextPipe.hasPoint = false;
            }
        }

        // the ground
        if (this.bird.pos.y > height - GROUND_HEIGHT) {
            this.bird.live = false;
        }

        // the ceiling too, so the rules we tell Jev are actually true
        if (this.bird.pos.y - JEV_COLLISION_R <= 0) {
            this.bird.live = false;
        }

        this.lastDescription = this.buildDescription();
        this.lastFields = this.lastDescription != null ? this.lastDescription.fields : null;

        this.maybeSend();
    }

    //the only place that flaps; it stamps a new flapSeq so older answers go stale
    doFlap() {
        this.bird.jump();
        this.flapSeq++;
        this.framesSinceFlap = 0;
        this.pendingFlap = false;
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

    drainAnswers() {
        let message = this.client.takeAnswer();
        while (message != null) {
            let tag = message.tag || {};
            //an answer about a scene we already flapped out of is worthless
            if (tag.runId !== this.runId || tag.flapSeq !== this.flapSeq) {
                this.client.stats.discarded++;
            } else {
                this.lastAnswers = message.answers;
                let flap = message.answers.flap;
                if (flap != null && flap.noul >= JevQuestions.FLAP_THRESHOLD) {
                    this.pendingFlap = true;
                }
            }
            message = this.client.takeAnswer();
        }
    }

    maybeSend() {
        if (!this.bird.live) return;
        if (this.sceneManager.getActiveScene() !== this) return;
        if (document.visibilityState !== "visible") return;
        if (this.lastDescription == null) return;
        if (this.frame - this.lastTickFrame < JEV_TICK_EVERY) return;
        if (!this.client.canSend()) return;

        let sent = this.client.send(this.lastDescription.state, JevQuestions.build(), {
            runId: this.runId,
            flapSeq: this.flapSeq,
            frame: this.frame
        });

        //a skipped send must not eat the tick
        if (sent) this.lastTickFrame = this.frame;
    }

    buildView() {
        let status = "live";
        if (!this.bird.live) status = "dead";
        else if (document.visibilityState !== "visible") status = "hidden";
        else if (Date.now() < this.client.backoffUntilMs) status = "backoff";

        let answers = this.lastAnswers || {};
        let stats = this.client.stats;

        return {
            status: status,
            fields: this.lastFields,
            flap: answers.flap || null,
            read: answers.read || null,
            danger: answers.danger || null,
            meta: {
                inFlight: this.client.inFlight + " / " + this.client.maxInFlight,
                requests: stats.requests + " sent, " + stats.answers + " back",
                tokens: stats.inputTokens + " in, " + stats.outputTokens + " out",
                latency: stats.lastLatencyMs + " ms",
                discarded: stats.discarded,
                errors: stats.errors + (stats.lastError != null ? " (" + stats.lastError + ")" : "")
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

        if (!this.bird.live) {
            push(); //dead panel, the restart itself happens in update()
                noStroke();
                fill(0, 0, 0, 255 * 0.70);
                rect(0, 0, width, height);

                textAlign(CENTER);
                fill(255);
                textSize(34);
                text("flight ended", width/2, height/2 - 20);
                textSize(22);
                text("score " + this.bird.score, width/2, height/2 + 14);

                //thin bar that fills while the hold runs out
                let barWidth = width * 0.4;
                let progress = min(this.deadFrames / JEV_DEATH_HOLD_FRAMES, 1);
                fill(255, 255, 255, 60);
                rect(width/2 - barWidth/2, height/2 + 40, barWidth, 4);
                fill(color(BIRD_COLOR));
                rect(width/2 - barWidth/2, height/2 + 40, barWidth * progress, 4);
            pop();
        }

        if (this.panel != null) this.panel.update(this.buildView());
    }

    exit() {
        super.exit();

        this.client.abortAll();

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
