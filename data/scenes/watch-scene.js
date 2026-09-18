// WatchScene: Jev plays Flappy Bird. Physics runs at a fixed 60 Hz and never blocks
// on the network. See docs/jev-design.md for the full contract this file implements.
class WatchScene extends Scene {
    constructor() {
        super();

        // Game objects
        this.bird = null;
        this.pipes = [];

        // State machine: 'idle' | 'running' | 'paused' | 'dead'. `error` overlays it.
        this.state = 'idle';
        this.error = null;

        // Decision-window bookkeeping
        this.generation = 0;
        this.windowIndex = 0;
        this.windowTick = 0;
        this.currentPlan = null;
        this.currentForecasts = null;
        this.pendingResponses = {};

        // Stats
        this.history = [];
        this.lateCount = 0;
        this.agreementTotal = 0;
        this.agreementAgree = 0;
        this.requestsSent = 0;
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
        this.latencies = [];
        this.tokensIn = 0;
        this.tokensOut = 0;
        this.deathAt = null;
        this.warmupDeadline = 0;
        this.startTime = 0;

        // Timing
        this.accumulator = 0;
        this.lastFrameAt = 0;

        // Fallbacks used when there is no panel (unit tests drive these directly).
        this.requestCap = 0;
        this.autoRestart = false;
        this.apiKey = '';

        this.panel = null;
        this.visibilityHandler = null;
        this.resizeHandler = null;
        this._canvasOrigLeft = undefined;
    }

    // ---- lifecycle ---------------------------------------------------------

    start() {
        super.start();
        this.panel = new JevConsole({
            onStart: () => this.handleStartClick(),
            onMenu: () => this.sceneManager.openScene(MENU_SCENE),
            onRetry: () => this.handleRetry()
        });
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.add('jev-watch-open');
        }
        this.resetGame();
        this.visibilityHandler = () => {
            if (typeof document !== 'undefined' && document.hidden && this.state === 'running') {
                // Pause without aborting: an in-flight answer is already paid for and is
                // reused on resume. No new request is sent while paused.
                this.state = 'paused';
                if (this.panel) {
                    this.panel.setStartButtonLabel('Resume');
                    this.panel.setStatus('Tab hidden: paused. Resume to continue.');
                }
            }
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);
        if (typeof window !== 'undefined') {
            this.resizeHandler = () => this.updateLayout();
            window.addEventListener('resize', this.resizeHandler);
        }
        this.updateLayout();
    }

    exit() {
        super.exit();
        if (this.visibilityHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
        }
        if (this.resizeHandler && typeof window !== 'undefined') {
            window.removeEventListener('resize', this.resizeHandler);
        }
        this.visibilityHandler = null;
        this.resizeHandler = null;
        this.cancelAllRequests();
        this.restoreCanvasPosition();
        if (this.panel) {
            this.panel.clearApiKey();
            this.panel.destroy();
            this.panel = null;
        }
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.remove('jev-watch-open');
        }
    }

    // ---- layout --------------------------------------------------------------

    findCanvas() {
        if (typeof document === 'undefined') return null;
        return document.querySelector('canvas');
    }

    // The console owns canvas placement once the game starts: the p5 canvas element is
    // moved into the console's GAME frame and CSS-scaled (no resizeCanvas). On exit it is
    // put back where p5 first placed it, inline style attribute restored verbatim.
    restoreCanvasPosition() {
        const canvasEl = this.findCanvas();
        if (canvasEl && this._canvasOrigStyle !== undefined) {
            if (typeof canvasEl.setAttribute === 'function') {
                canvasEl.setAttribute('style', this._canvasOrigStyle);
            }
            if (this._canvasOrigParent && typeof this._canvasOrigParent.appendChild === 'function') {
                this._canvasOrigParent.appendChild(canvasEl);
            } else if (typeof document !== 'undefined' && document.body) {
                document.body.appendChild(canvasEl);
            }
        }
        this._canvasOrigStyle = undefined;
        this._canvasOrigParent = undefined;
    }

    updateLayout() {
        if (!this.panel) return;
        const canvasEl = this.findCanvas();
        const wide = (typeof window !== 'undefined' ? window.innerWidth : 1200) >= 900;
        let rect = { left: 0, top: 0, width: 0, height: 0 };
        if (canvasEl) {
            if (this._canvasOrigStyle === undefined) {
                this._canvasOrigStyle = (typeof canvasEl.getAttribute === 'function' && canvasEl.getAttribute('style')) || '';
                this._canvasOrigParent = canvasEl.parentNode || null;
            }
            const frame = typeof this.panel.getGameFrame === 'function' ? this.panel.getGameFrame() : null;
            if (frame && canvasEl.parentNode !== frame) {
                frame.appendChild(canvasEl);
            }
            canvasEl.style.position = 'static';
            canvasEl.style.left = '';
            canvasEl.style.top = '';
            // Replaced element with auto size + both max constraints keeps its aspect ratio.
            canvasEl.style.width = 'auto';
            canvasEl.style.height = 'auto';
            canvasEl.style.maxWidth = '100%';
            canvasEl.style.maxHeight = '100%';
            canvasEl.style.display = 'block';
            if (typeof canvasEl.getBoundingClientRect === 'function') {
                rect = canvasEl.getBoundingClientRect();
            }
        }
        this.panel.layout(rect, wide);
    }

    // ---- session controls ------------------------------------------------

    handleStartClick() {
        if (this.error) return;
        const now = this.now();
        switch (this.state) {
            case 'idle':
                this.state = 'running';
                this.lastFrameAt = now;
                this.startTime = now;
                this.primeFirstWindow();
                if (this.panel) { this.panel.setStartButtonLabel('Pause'); this.panel.setStatus('Running'); }
                break;
            case 'running':
                this.state = 'paused';
                if (this.panel) { this.panel.setStartButtonLabel('Resume'); this.panel.setStatus('Paused'); }
                break;
            case 'paused':
                this.state = 'running';
                this.lastFrameAt = now;
                if (this.panel) { this.panel.setStartButtonLabel('Pause'); this.panel.setStatus('Running'); }
                break;
            case 'dead':
                this.resetGame();
                this.state = 'running';
                this.lastFrameAt = now;
                this.startTime = now;
                this.primeFirstWindow();
                if (this.panel) { this.panel.setStartButtonLabel('Pause'); this.panel.setStatus('Running'); }
                break;
        }
    }

    // Window 0 has no earlier window to pipeline from, so ask Jev for it right away and
    // hold the first tick briefly (at most WARMUP_MS) until that answer arrives.
    primeFirstWindow() {
        if (this.windowIndex !== 0 || this.windowTick !== 0) return;
        this.warmupDeadline = this.now() + WatchScene.WARMUP_MS;
        this.maybeSendRequest(0, this.gameState());
    }

    handleRetry() {
        this.error = null;
        if (this.panel) {
            this.panel.clearError();
            this.panel.setStatus(this.state === 'running' ? 'Running' : 'Paused');
        }
    }

    enterError(message) {
        this.error = message;
        this.cancelAllRequests();
        if (this.panel) {
            this.panel.showError(message);
            this.panel.setStatus('Error');
        }
    }

    getCap() {
        return this.panel ? this.panel.getCap() : this.requestCap;
    }

    getAutoRestart() {
        return this.panel ? this.panel.getAutoRestart() : this.autoRestart;
    }

    getApiKey() {
        return this.panel ? this.panel.getApiKey() : (this.apiKey || '');
    }

    now() {
        return (typeof performance !== 'undefined') ? performance.now() : Date.now();
    }

    // ---- game reset --------------------------------------------------------

    resetGame() {
        this.cancelAllRequests();

        this.bird = new Bird(BIRD_X, 100);
        this.pipes = [];
        const pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);
        for (let i = 1; i <= pipeCount + 2; i++) {
            new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height - PIPE_NO_GAP_ZONE));
        }

        this.windowIndex = 0;
        this.windowTick = 0;
        this.currentPlan = null;
        this.currentForecasts = null;
        this.pendingResponses = {};

        this.history = [];
        this.lateCount = 0;
        this.agreementTotal = 0;
        this.agreementAgree = 0;
        this.requestsSent = 0;
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
        this.latencies = [];
        this.tokensIn = 0;
        this.tokensOut = 0;
        this.deathAt = null;
        this.warmupDeadline = 0;
        this.startTime = this.now();

        this.accumulator = 0;
        this.lastFrameAt = this.now();

        this.state = 'idle';
        this.error = null;

        if (this.panel) {
            this.panel.clearError();
            this.panel.setStartButtonLabel('Start');
            this.panel.setStatus('Enter an API key (optional if the server has one) and press Start.');
            this.panel.setHistory([]);
            this.panel.setDecision({ plan: 'no_flap', answers: null, probabilities: {}, confidence: null, late: false });
            this.panel.setComparison(null, NaN);
            this.panel.setUsage({ requests: 0, onTimePct: NaN, tokensIn: 0, tokensOut: 0, cost: 0, reqPerSec: 0 });
            this.panel.setLastExchange(null, null);
        }
    }

    // ---- contract state ----------------------------------------------------

    gameState() {
        const radius = this.bird.radius - 10; // collision radius, see utils.circleRect
        return {
            bird: { x: this.bird.pos.x, y: this.bird.pos.y, velocity: this.bird.velocity, radius },
            world: { width, groundY: height - GROUND_HEIGHT },
            physics: { gravity: GRAVITY, jumpPower: BIRD_JUMP_POWER, pipeSpeed: PIPE_SCROOL },
            pipes: this.pipes
                .filter(p => p.topPipe.x2 >= this.bird.pos.x - radius)
                .slice(0, 4)
                .map(p => ({ left: p.topPipe.x1, right: p.topPipe.x2, gapTop: p.topPipe.y2, gapBottom: p.bottomPipe.y1 }))
        };
    }

    // ---- fixed-step loop ---------------------------------------------------

    update() {
        super.update();

        const now = this.now();
        let delta = now - this.lastFrameAt;
        this.lastFrameAt = now;
        if (!(delta >= 0)) delta = 0;
        if (delta > 50) delta = 50;

        if (this.state === 'dead') {
            const cap = this.getCap();
            const capOk = cap === 0 || this.requestsSent < cap;
            const hidden = typeof document !== 'undefined' && document.hidden;
            if (this.getAutoRestart() && this.deathAt !== null && (now - this.deathAt) >= 2000 && capOk && !hidden) {
                this.resetGame();
                this.state = 'running';
                this.lastFrameAt = now;
                this.startTime = now;
                this.primeFirstWindow();
                if (this.panel) { this.panel.setStartButtonLabel('Pause'); this.panel.setStatus('Running'); }
            }
            return;
        }

        if (this.state !== 'running' || this.error) return;

        // Warm-up: before the very first tick, wait (bounded) for Jev's answer to window 0.
        if (this.warmupDeadline) {
            const first = this.pendingResponses[0];
            if (first && first.status === 'pending' && now < this.warmupDeadline) {
                this.accumulator = 0;
                return;
            }
            this.warmupDeadline = 0;
        }

        this.accumulator += delta;
        const tickMs = 1000 / 60;
        let guard = 0;
        // Small epsilon guards against float drift in the accumulator (e.g. 16.66666...).
        while (this.accumulator + 1e-6 >= tickMs && this.bird.live && this.state === 'running' && guard < 240) {
            this.accumulator -= tickMs;
            this.tick();
            guard++;
        }
    }

    tick() {
        if (this.windowTick === 0) {
            this.commitWindow();
        }
        if (this.currentPlan && JevPhysics.FLAP_TICKS[this.currentPlan].includes(this.windowTick)) {
            this.bird.jump();
        }
        this.step();
        if (this.state === 'dead') return;
        this.windowTick++;
        if (this.windowTick >= JevPhysics.HORIZON) {
            this.windowTick = 0;
            this.windowIndex++;
        }
    }

    commitWindow() {
        const k = this.windowIndex;
        const record = this.pendingResponses[k];
        const state = this.gameState();
        this.currentForecasts = JevPhysics.forecastPlans(state);
        const physicsBest = JevPhysics.bestPlan(this.currentForecasts);
        let plan, answers, latencyMs, usage, late;
        if (record && record.status === 'resolved') {
            plan = record.plan;
            answers = record.answers;
            latencyMs = record.latencyMs;
            usage = record.usage;
            late = false;
        } else {
            // Jev's answer did not arrive in time. Use the physics heuristic for this
            // window only and label it LATE so the fallback is never mistaken for Jev.
            plan = physicsBest;
            answers = null;
            latencyMs = null;
            usage = null;
            late = true;
            this.lateCount++;
        }
        delete this.pendingResponses[k];

        this.currentPlan = plan;
        const agree = plan === physicsBest;
        this.agreementTotal++;
        if (agree) this.agreementAgree++;

        if (!late) this.recordLatency(latencyMs);
        if (usage) {
            this.tokensIn += usage.input_tokens || 0;
            this.tokensOut += usage.output_tokens || 0;
        }

        // probabilities/confidence kept on the decision record for backward compatibility
        // with the console UI; derived from the climb judgment.
        const probabilities = answers && answers.climb ? answers.climb.probabilities : null;
        const confidence = answers && answers.climb ? answers.climb.confidence : null;

        const decision = { index: k, plan, answers, probabilities, confidence, latencyMs, late, physicsBest, agree };
        this.history.push(decision);
        if (this.history.length > 50) this.history.shift();

        this.updatePanel(decision, physicsBest);

        const nextState = JevPhysics.advance(state, plan);
        this.maybeSendRequest(k + 1, nextState);
    }

    recordLatency(latencyMs) {
        if (!Number.isFinite(latencyMs)) return;
        this.latencies.push(latencyMs);
        if (this.latencies.length > 100) this.latencies.shift();
    }

    getLatencyAvg() {
        if (!this.latencies.length) return NaN;
        return this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length;
    }

    getLatencyP95() {
        if (!this.latencies.length) return NaN;
        const sorted = this.latencies.slice().sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
        return sorted[idx];
    }

    updatePanel(decision, physicsBest) {
        if (!this.panel) return;
        this.panel.setDecision({
            plan: decision.plan,
            answers: decision.answers,
            probabilities: decision.probabilities || {},
            confidence: decision.confidence,
            late: decision.late,
            latencyMs: decision.latencyMs,
            latencyAvg: this.getLatencyAvg(),
            latencyP95: this.getLatencyP95()
        });
        const agreePct = this.agreementTotal ? (this.agreementAgree / this.agreementTotal * 100) : NaN;
        this.panel.setComparison(physicsBest, agreePct);
        const totalWindows = this.history.length;
        const onTimePct = totalWindows ? ((totalWindows - this.lateCount) / totalWindows * 100) : NaN;
        const elapsedS = this.startTime ? (this.now() - this.startTime) / 1000 : 0;
        this.panel.setUsage({
            requests: this.requestsSent,
            onTimePct,
            tokensIn: this.tokensIn,
            tokensOut: this.tokensOut,
            cost: this.tokensIn * 0.042 / 1e6,
            reqPerSec: elapsedS > 0 ? this.requestsSent / elapsedS : 0
        });
        this.panel.setHistory(this.history.map(h => ({
            index: h.index,
            plan: h.plan,
            probability: h.probabilities ? h.probabilities[h.plan] : undefined,
            latencyMs: h.latencyMs,
            late: h.late
        })));
    }

    // ---- physics step -------------------------------------------------------

    step() {
        if (this.state === 'dead') return;

        // Manual pipe recycling (kept from the prototype: Pipe.update's own recycling
        // assumes a different scene loop and would desync the pipe count here).
        const pipeCount = this.pipes.length;
        let lastX = this.pipes[this.pipes.length - 1].pos.x;
        this.pipes = this.pipes.filter(pipe => pipe.pos.x - pipe.velocity >= -pipe.width / 2);
        while (this.pipes.length < pipeCount) {
            lastX += PIPE_BETWEEN + PIPE_WIDTH;
            new Pipe(lastX, random(PIPE_NO_GAP_ZONE, height - PIPE_NO_GAP_ZONE));
        }

        this.pipes.forEach(pipe => pipe.update());
        this.bird.update();

        const half = this.bird.radius - 10;
        for (const pipe of this.pipes) {
            if (circleRect(this.bird, pipe.topPipe) || circleRect(this.bird, pipe.bottomPipe)) {
                this.bird.live = false;
            }
            if (this.bird.live && pipe.hasPoint && this.bird.pos.x > pipe.pos.x) {
                this.bird.score++;
                pipe.hasPoint = false;
            }
        }
        if (this.bird.pos.y + half >= height - GROUND_HEIGHT) {
            this.bird.live = false;
        }

        if (!this.bird.live) {
            this.die();
        }
    }

    die() {
        this.state = 'dead';
        this.cancelAllRequests();
        this.deathAt = this.now();
        if (this.panel) {
            this.panel.setStartButtonLabel('Play again');
            this.panel.setStatus('Game over | score ' + this.bird.score);
        }
    }

    // ---- networking ---------------------------------------------------------

    cancelAllRequests() {
        this.generation++;
        for (const id in this.pendingResponses) {
            const rec = this.pendingResponses[id];
            if (rec && rec.controller) {
                try { rec.controller.abort(); } catch (e) { /* ignore */ }
            }
        }
        this.pendingResponses = {};
    }

    maybeSendRequest(id, state) {
        const cap = this.getCap();
        if (cap > 0 && this.requestsSent >= cap) {
            if (this.state === 'running') {
                this.state = 'paused';
                if (this.panel) {
                    this.panel.setStartButtonLabel('Resume');
                    this.panel.setStatus('Request cap reached (' + cap + '). Raise the cap or resume manually.');
                }
            }
            return;
        }
        if (this.state !== 'running' || this.error) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        if (this.backoffUntil && this.now() < this.backoffUntil) return;
        this.sendRequest(id, state);
    }

    sendRequest(id, state) {
        const generation = this.generation;
        const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        this.pendingResponses[id] = { status: 'pending', controller };
        this.requestsSent++;

        const apiKey = this.getApiKey();
        const startedAt = this.now();
        let timeoutId = null;
        if (controller) {
            timeoutId = setTimeout(() => controller.abort(), 4000);
        }

        let requestForInspector = null;
        try { requestForInspector = JevContract.buildRequest(state); } catch (e) { /* ignore */ }
        if (this.panel) this.panel.setLastExchange(requestForInspector, null);

        const fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, state, apiKey })
        };
        if (controller) fetchOptions.signal = controller.signal;

        fetch('/api/jev/decide', fetchOptions)
            .then(async response => {
                if (timeoutId) clearTimeout(timeoutId);
                const latencyMs = this.now() - startedAt;
                let json = null;
                try { json = await response.json(); } catch (e) { /* ignore */ }
                if (generation !== this.generation) return;

                if (response.status === 401) {
                    delete this.pendingResponses[id];
                    this.enterError((json && json.error) || 'TypeSafe rejected the API key.');
                    return;
                }
                if (response.status === 429) {
                    delete this.pendingResponses[id];
                    const retryAfterMs = (json && Number.isFinite(json.retryAfterMs)) ? json.retryAfterMs : 2000;
                    this.backoffUntil = this.now() + retryAfterMs;
                    this.consecutiveFailures = 0;
                    if (this.panel) this.panel.setStatus('Rate limited by TypeSafe. Backing off ' + Math.round(retryAfterMs) + ' ms.');
                    if (this.panel) this.panel.setLastExchange(requestForInspector, json);
                    return;
                }
                if (!response.ok || !json || json.id !== id || !JevContract.PLANS.includes(json.plan) || !json.answers) {
                    delete this.pendingResponses[id];
                    this.consecutiveFailures++;
                    if (this.consecutiveFailures >= 3) {
                        this.enterError((json && json.error) || 'Jev request failed repeatedly.');
                    }
                    return;
                }

                this.consecutiveFailures = 0;
                this.pendingResponses[id] = {
                    status: 'resolved',
                    plan: json.plan,
                    answers: json.answers,
                    latencyMs: Number.isFinite(json.latencyMs) ? json.latencyMs : latencyMs,
                    usage: json.usage || null
                };
                if (this.panel) this.panel.setLastExchange(requestForInspector, json);
            })
            .catch(error => {
                if (timeoutId) clearTimeout(timeoutId);
                if (generation !== this.generation) return;
                delete this.pendingResponses[id];
                this.consecutiveFailures++;
                if (this.consecutiveFailures >= 3) {
                    this.enterError(error && error.name === 'AbortError' ? 'Jev request timed out repeatedly.' : 'Network error talking to Jev.');
                }
            });
    }

    // ---- rendering ------------------------------------------------------------

    draw() {
        background(color(BG_COLOR));

        this.pipes.forEach(pipe => pipe.show());
        this.bird.show();

        push();
        noStroke();
        fill(color(GROUND_COLOR));
        rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
        pop();

        push();
        textAlign(CENTER);
        fill(255);
        textSize(60);
        text(this.bird.score, width / 2, 60);
        pop();

        this.drawForecastOverlay();

        if (this.state === 'dead') {
            push();
            fill(0, 0, 0, 255 * 0.7);
            rect(0, 0, width, height);
            pop();
            push();
            textAlign(CENTER);
            fill(255);
            textSize(60);
            text('Game Over', width / 2, height / 2);
            textSize(24);
            text('Score: ' + this.bird.score, width / 2, height / 2 + 40);
            pop();
        }
    }

    drawForecastOverlay() {
        if (!this.currentForecasts || this.state === 'dead') return;
        push();
        noFill();
        for (const plan of JevPhysics.PLANS) {
            const forecast = this.currentForecasts[plan];
            if (!forecast || !forecast.trajectory || !forecast.trajectory.length) continue;
            const chosen = plan === this.currentPlan;
            stroke(chosen ? color(255, 255, 255, 230) : color(255, 255, 255, 55));
            strokeWeight(chosen ? 2 : 1);
            beginShape();
            for (const point of forecast.trajectory) {
                vertex(this.bird.pos.x + point.tick * PIPE_SCROOL, point.y);
            }
            endShape();
        }
        pop();

        const state = this.gameState();
        if (state.pipes.length) {
            const p = state.pipes[0];
            const cy = (p.gapTop + p.gapBottom) / 2;
            push();
            stroke(255, 255, 255, 180);
            strokeWeight(1);
            line(p.left, cy, p.right, cy);
            noStroke();
            fill(255, 255, 255, 220);
            ellipse((p.left + p.right) / 2, cy, 6, 6);
            pop();
        }
    }
}

// Longest the first tick waits for Jev's answer to window 0 before starting anyway.
WatchScene.WARMUP_MS = 600;

if (typeof module !== 'undefined' && module.exports) module.exports = WatchScene;
