class WatchScene extends Scene {
    constructor() {
        super();
        this.calls = 0;
        this.callLimit = 60;
        this.lastCallAt = -Infinity;
        this.active = false;
        this.generation = 0;
        this.controller = null;
    }

    setupUI() {
        this.panel = createDiv();
        this.panel.addClass('jev-panel');
        this.statusLabel = createDiv('Enter an API key or use the server key, then Start.');
        this.statusLabel.parent(this.panel);
        this.statusLabel.attribute('role', 'status');
        this.keyInput = createInput('', 'password');
        this.keyInput.parent(this.panel);
        this.keyInput.attribute('placeholder', 'TypeSafe API key (optional with .env)');
        this.keyInput.attribute('aria-label', 'TypeSafe API key');
        this.keyInput.attribute('autocomplete', 'off');
        this.keyInput.attribute('spellcheck', 'false');
        this.pauseButton = createButton('Start');
        this.pauseButton.parent(this.panel);
        this.pauseButton.mouseClicked(() => {
            if (!this.superBird.live) { this.resetGame(); }
            if (this.calls >= this.callLimit) { this.setStatus('Session budget exhausted. No more API calls.'); return; }
            this.paused = !this.paused;
            if (this.paused) this.cancelDecision();
            this.pauseButton.html(this.paused ? 'Resume' : 'Pause');
            this.setStatus(this.paused ? 'Paused' : 'Jev ready');
        });
        this.retryButton = createButton('Retry');
        this.retryButton.parent(this.panel);
        this.retryButton.hide();
        this.retryButton.mouseClicked(() => {
            this.error = null;
            this.retryButton.hide();
            this.setStatus(this.paused ? 'Paused' : 'Jev ready');
        });
        this.budgetLabel = createDiv('');
        this.budgetLabel.parent(this.panel);
        this.autoRestart = createCheckbox(' Auto restart after death (same call budget)', false);
        this.autoRestart.parent(this.panel);
        this.restartButton = createButton('Restart');
        this.restartButton.parent(this.panel);
        this.restartButton.mouseClicked(() => this.resetGame());
        this.returnToMenuButton = createButton('Menu');
        this.returnToMenuButton.parent(this.panel);
        this.returnToMenuButton.mouseClicked(() => this.sceneManager.openScene(MENU_SCENE));
    }

    setStatus(message) {
        this.statusLabel.elt.textContent = message;
    }

    start() {
        super.start();
        this.originalSize = { width, height };
        resizeCanvas(800, 500);
        this.dashboard = new JevDashboard(this);
        this.setupUI();
        this.dashboard.attachControls(this.panel);
        this.resetGame();
        this.visibilityHandler = () => {
            if (document.hidden) {
                this.paused = true;
                this.cancelDecision();
                this.pauseButton.html('Resume');
                this.setStatus('Tab hidden: paused. Resume to continue.');
            }
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    cancelDecision() {
        this.generation++;
        if (this.controller) this.controller.abort();
        this.controller = null;
        this.pending = false;
        this.readyDecision = null;
    }

    resetGame() {
        this.cancelDecision();
        this.active = true;
        this.deathAt = null;
        this.paused = true;
        this.error = null;
        this.framesRemaining = 0;
        this.readyDecision = null;
        this.decisions = 0;
        this.elapsed = 0;
        this.lastFrameAt = performance.now();
        this.pauseButton.html('Start');
        this.retryButton.hide();
        this.lastControl = null;
        this.setStatus('Enter an API key or use the server key, then Start.');
        this.superBird = new Bird(BIRD_X, Math.min(100, (height - GROUND_HEIGHT) / 2));
        this.pipes = [];
        const groundY = height - GROUND_HEIGHT;
        const margin = Math.min(PIPE_NO_GAP_ZONE, (groundY - PIPE_GAP_H) / 2);
        for (let i = 1; i <= width / (PIPE_BETWEEN + PIPE_WIDTH) + 2; i++) {
            new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH),
                random(Math.max(PIPE_GAP_H / 2, margin), Math.min(groundY - PIPE_GAP_H / 2, groundY - margin)));
        }
        if (this.dashboard && this.calls === 0) this.dashboard.showRequest(JevContract.buildRequest(this.gameState()));
    }

    gameState() {
        return {
            bird: { x: this.superBird.pos.x, y: this.superBird.pos.y,
                velocity: this.superBird.velocity, collisionRadius: this.superBird.radius - 10 },
            world: { width, groundY: height - GROUND_HEIGHT },
            physics: { gravity: GRAVITY, jumpPower: BIRD_JUMP_POWER, pipeSpeed: PIPE_SCROOL },
            decisionFrames: 6,
            pipes: this.pipes.filter(p => p.topPipe.x2 >= this.superBird.pos.x - (this.superBird.radius - 10))
                .slice(0, 3).map(p => ({ left: p.topPipe.x1, right: p.topPipe.x2,
                    gapTop: p.topPipe.y2, gapBottom: p.bottomPipe.y1 }))
        };
    }

    async requestDecision() {
        if (!this.active || this.paused || this.error || !this.superBird.live || this.pending || this.readyDecision) return;
        if (this.calls >= this.callLimit) {
            this.paused = true;
            this.pauseButton.html('Budget exhausted');
            this.setStatus('Session budget exhausted. No more API calls.');
            return;
        }
        if (performance.now() - this.lastCallAt < 1200) return;
        this.calls++;
        this.lastCallAt = performance.now();
        if (this.budgetLabel) this.budgetLabel.elt.textContent = 'API attempts: ' + this.calls + ' / ' + this.callLimit;
        const generation = this.generation;
        const controller = new AbortController();
        this.controller = controller;
        this.pending = true;
        this.setStatus('Jev is deciding...');
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const state = this.gameState();
            if (this.dashboard) this.dashboard.showRequest(JevContract.buildRequest(state), true);
            const response = await fetch('/api/jev/action', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state, apiKey: this.keyInput.value().trim() }),
                signal: controller.signal
            });
            const result = await response.json();
            if (generation !== this.generation) return;
            if (!response.ok) throw new Error(result.error || 'Jev request failed.');
            if (!['flap', 'coast'].includes(result.action) || result.decisionFrames !== 6 ||
                !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
                throw new Error('Invalid Jev decision.');
            }
            // update() applies the result; pausing during a request never moves the bird.
            this.readyDecision = result;
            if (this.dashboard) this.dashboard.showResult(result);
        } catch (error) {
            if (generation !== this.generation) return;
            this.error = error.name === 'AbortError' ? 'Jev timed out. Retry.' : error.message;
            this.setStatus(this.error);
            if (this.dashboard) {
                this.dashboard.field('response-title', 'REQUEST FAILED');
                this.dashboard.field('response', this.error);
            }
            this.retryButton.show();
        } finally {
            clearTimeout(timeout);
            if (generation === this.generation) {
                this.pending = false;
                this.controller = null;
            }
        }
    }

    update() {
        super.update();
        const now = performance.now();
        const delta = Math.min(now - this.lastFrameAt, 50);
        this.lastFrameAt = now;
        if (!this.superBird.live) {
            this.elapsed = 0;
            if ((typeof document === 'undefined' || !document.hidden) && this.autoRestart?.checked() && this.deathAt !== null && now - this.deathAt >= 2000 && this.calls < this.callLimit) {
                this.resetGame();
                this.paused = false;
                this.pauseButton.html('Pause');
            }
            return;
        }
        if (!this.active || this.paused || this.error || this.pending) {
            this.elapsed = 0;
            return;
        }
        if (this.readyDecision) {
            const result = this.readyDecision;
            this.readyDecision = null;
            const forecasts = JevPhysics.evidence(this.gameState());
            let action = result.action;
            // Reject a predicted immediate collision only when the other action is safer.
            const other = action === 'flap' ? 'coast' : 'flap';
            if (!forecasts[action].safeUntilNextDecision && forecasts[other].safeUntilNextDecision) action = other;
            this.lastControl = action !== result.action ? 'SAFETY' : 'JEV / ' + action.toUpperCase();
            if (action === 'flap') this.superBird.jump();
            this.framesRemaining = result.decisionFrames;
            this.decisions++;
            this.setStatus(`Jev: ${result.action}${action !== result.action ? " (safety: " + action + ")" : ""} | confidence ${Math.round(result.confidence * 100)}% | ${result.latencyMs} ms | #${this.decisions}`);
        }
        if (this.framesRemaining === 0) {
            this.elapsed = 0;
            const forecast = JevPhysics.predict(this.gameState(), 'coast');
            if (this.superBird.velocity < 0 && forecast.safeUntilNextDecision) {
                this.framesRemaining = 6;
                this.lastControl = 'LOCAL COAST';
                this.setStatus('Rising: coast safely (no API call)');
            } else {
                if (now - this.lastCallAt < 1200) this.setStatus('Waiting for call interval (no API call)');
                this.requestDecision();
            }
            return;
        }
        // Fixed 60 Hz physics, irrespective of display refresh rate. No network catch-up.
        this.elapsed += delta;
        while (this.elapsed >= 1000 / 60 && this.framesRemaining > 0 && this.superBird.live) {
            this.elapsed -= 1000 / 60;
            this.framesRemaining--;
            this.step();
        }
    }

    step() {
        // Manage recycling here: Pipe.update's legacy recycling assumes a different scene loop.
        const pipeCount = this.pipes.length;
        let lastX = this.pipes[this.pipes.length - 1].pos.x;
        this.pipes = this.pipes.filter(pipe => pipe.pos.x - pipe.velocity >= -pipe.width / 2);
        while (this.pipes.length < pipeCount) {
            const groundY = height - GROUND_HEIGHT;
            lastX += PIPE_BETWEEN + PIPE_WIDTH;
            new Pipe(lastX,
                random(PIPE_GAP_H / 2 + 25, groundY - PIPE_GAP_H / 2 - 25));
        }
        this.pipes.forEach(pipe => pipe.update());
        this.superBird.update();
        for (const pipe of this.pipes) {
            if (circleRect(this.superBird, pipe.topPipe) || circleRect(this.superBird, pipe.bottomPipe)) {
                this.superBird.live = false;
            }
            if (this.superBird.live && pipe.hasPoint && pipe.topPipe.x2 < this.superBird.pos.x - (this.superBird.radius - 10)) {
                this.superBird.score++;
                pipe.hasPoint = false;
            }
        }
        if (this.superBird.pos.y + (this.superBird.radius - 10) >= height - GROUND_HEIGHT || this.superBird.pos.y - (this.superBird.radius - 10) <= 0) this.superBird.live = false;
        if (!this.superBird.live) {
            this.cancelDecision();
            this.deathAt = performance.now();
            this.paused = true;
            this.pauseButton.html('Play again');
            this.setStatus('Game over | score ' + this.superBird.score + ' | No API calls. Play again or enable auto restart.');
        }
    }

    draw() {
        if (this.dashboard) this.dashboard.update();
        background('#050d0a');
        push();
        stroke('#10291e');
        strokeWeight(1);
        for (let x = 0; x < width; x += 40) line(x, 0, x, height);
        for (let y = 0; y < height; y += 40) line(0, y, width, y);
        pop();
        push();
        stroke('#277c4d');
        fill('#0c2e1c');
        this.pipes.forEach(pipe => {
            rect(pipe.topPipe.x1, 0, pipe.width, pipe.topPipe.y2);
            rect(pipe.bottomPipe.x1, pipe.bottomPipe.y1, pipe.width, height - pipe.bottomPipe.y1);
        });
        noStroke();
        fill('#e8c66b');
        ellipse(this.superBird.pos.x, this.superBird.pos.y, this.superBird.radius, this.superBird.radius);
        pop();
        push();
        noStroke();
        fill('#0a2116');
        rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
        textAlign(CENTER);
        fill(255);
        textSize(60);
        text(this.superBird.score, width / 2, 60);
        pop();
    }

    exit() {
        super.exit();
        this.active = false;
        if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
        this.cancelDecision();
        if (this.keyInput) this.keyInput.value('');
        if (this.panel) this.panel.remove();
        if (this.dashboard) { this.dashboard.destroy(); this.dashboard = null; }
        if (this.originalSize) resizeCanvas(this.originalSize.width, this.originalSize.height);
    }
}
