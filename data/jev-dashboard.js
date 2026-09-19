class JevDashboard {
    constructor(scene) {
        this.scene = scene;
        this.root = document.createElement('main');
        this.root.className = 'jev-console';
        this.root.innerHTML = `
            <header class="console-header"><div><span class="signal-dot"></span> JEV <span class="muted">/</span> FLIGHT LAB</div><span class="console-tag">FLAPPY BIRD · SYSTEM ONE</span></header>
            <section class="console-grid">
                <div class="flight-column">
                    <div class="section-heading"><span>01 / LIVE SIMULATION</span><span data-field="mode">STANDBY</span></div>
                    <div class="flight-screen"></div>
                    <div class="flight-readout"><span>SCORE <b data-field="score">0</b></span><span>HEIGHT <b data-field="height">—</b></span><span>VELOCITY <b data-field="velocity">—</b></span><span>CONTROL <b data-field="control">—</b></span></div>
                    <div class="control-mount"></div>
                </div>
                <aside class="judgment-column">
                    <div class="section-heading">02 / MODEL JUDGMENT <span data-field="model">jev-latest</span></div>
                    <h1>One impulse.<br>One decision.</h1>
                    <p class="question-caption">Should the bird flap now, or coast toward the next gap?</p>
                    <div class="decision-banner"><span>LAST MODEL CHOICE</span><strong data-field="choice">AWAITING INPUT</strong></div>
                    <div class="probability"><div><span>FLAP</span><b data-field="flap-value">—</b></div><div class="bar-track"><i data-bar="flap"></i></div></div>
                    <div class="probability"><div><span>COAST</span><b data-field="coast-value">—</b></div><div class="bar-track"><i data-bar="coast"></i></div></div>
                    <div class="judgment-meta"><span>CONFIDENCE <b data-field="confidence">—</b></span><span>LATENCY <b data-field="latency">—</b></span></div>
                    <p class="model-note">Probabilities describe the last Jev response. Local physics steps do not produce new model scores.</p>
                    <div class="section-heading small-heading">PHYSICS / NEXT 6 TICKS</div>
                    <div class="forecast-row"><span>FLAP</span><b data-field="flap-risk">—</b></div>
                    <div class="forecast-row"><span>COAST</span><b data-field="coast-risk">—</b></div>
                    <div class="forecast-row"><span>NEXT GAP CENTER</span><b data-field="target">—</b></div>
                    <div class="budget-meter"><span>SESSION API ATTEMPTS</span><b data-field="calls">0 / 60</b></div>
                </aside>
            </section>
            <section class="trace-section"><div class="section-heading"><span>03 / DECISION FLOW</span><span>GREEN: ACTIVE · AMBER: SAFETY</span></div>
                <div class="flow-diagram" aria-label="Decision flow">
                    <div data-node="state">GAME STATE<small>position · velocity · pipes</small></div><span>→</span>
                    <div data-node="gate">CALL GATE<small>alive · budget · interval</small></div><span>→</span>
                    <div data-node="model">JEV / CHOICE<small>flap or coast</small></div><span>→</span>
                    <div data-node="safety">SAFETY CHECK<small>collision forecast</small></div><span>→</span>
                    <div data-node="apply">6 PHYSICS TICKS<small>apply once · observe again</small></div>
                </div><p class="flow-caption" data-field="flow">Paused. No API request is being sent.</p>
            </section>
            <section class="inspector-section"><div class="section-heading"><span>04 / API INSPECTOR</span><span>AUTHORIZATION IS NEVER DISPLAYED</span></div>
                <div class="inspector-grid"><details open><summary data-field="request-title">EXAMPLE REQUEST · NOT SENT</summary><div class="endpoint">POST https://api.typesafe.ai/v1/systemone<br>Authorization: Bearer &lt;TYPESAFE_API_KEY&gt;</div><pre data-field="request"></pre></details>
                <details open><summary data-field="response-title">RESPONSE · WAITING</summary><pre data-field="response">No API call yet. Enter a key and press Start to see a real response.</pre></details></div>
            </section>`;
        document.body.appendChild(this.root);
        document.body.classList.add('watch-console-open');
        this.canvas = document.querySelector('canvas');
        this.canvasParent = this.canvas.parentNode;
        this.canvasStyle = this.canvas.getAttribute('style');
        this.root.querySelector('.flight-screen').appendChild(this.canvas);
        this.canvas.style.cssText = 'position:static;display:block;width:100%;height:auto;';
    }
    field(name, value) { this.root.querySelector(`[data-field="${name}"]`).textContent = value; }
    attachControls(panel) { this.root.querySelector('.control-mount').appendChild(panel.elt); }
    showRequest(request, sent = false) {
        this.field('request-title', sent ? 'LATEST REQUEST · SENT TO JEV' : 'EXAMPLE REQUEST · NOT SENT');
        this.field('request', JSON.stringify(request, null, 2));
    }
    showResult(result) {
        this.field('choice', result.action.toUpperCase());
        for (const action of ['flap', 'coast']) {
            const p = result.probabilities?.[action];
            this.field(action + '-value', Number.isFinite(p) ? (p * 100).toFixed(1) + '%' : '—');
            this.root.querySelector(`[data-bar="${action}"]`).style.width = Number.isFinite(p) ? p * 100 + '%' : '0%';
        }
        this.field('confidence', Math.round(result.confidence * 100) + '%');
        this.field('latency', result.latencyMs + ' ms');
        this.field('model', result.model || 'Jev');
        if (result.request) this.showRequest(result.request, true);
        this.field('response-title', 'LATEST RESPONSE · LOCAL PROXY');
        const { request, ...response } = result;
        this.field('response', JSON.stringify(response, null, 2));
    }
    update() {
        const s = this.scene;
        if (!s.superBird) return;
        this.field('score', s.superBird.score);
        this.field('height', Math.round(s.superBird.pos.y) + ' px');
        this.field('velocity', s.superBird.velocity.toFixed(1));
        this.field('calls', s.calls + ' / ' + s.callLimit);
        const mode = !s.superBird.live ? 'GAME OVER' : s.error ? 'ERROR' : s.paused ? 'PAUSED' : s.pending ? 'THINKING' : 'RUNNING';
        this.field('mode', mode);
        this.field('control', s.lastControl || '—');
        const forecast = JevPhysics.evidence(s.gameState());
        for (const action of ['flap', 'coast']) this.field(action + '-risk', forecast[action].safeUntilNextDecision ? 'CLEAR' : 'COLLISION PREDICTED');
        this.field('target', Math.round(forecast.targetY) + ' px');
        const node = ['GAME OVER', 'ERROR', 'PAUSED'].includes(mode) ? 'gate' : s.pending ? 'model' : s.framesRemaining ? 'apply' : 'gate';
        for (const el of this.root.querySelectorAll('[data-node]')) {
            el.classList.toggle('active', el.dataset.node === node);
            el.classList.toggle('intervention', el.dataset.node === 'safety' && s.lastControl === 'SAFETY');
        }
        this.field('flow', s.statusLabel.elt.textContent);
    }
    destroy() {
        this.canvasParent.appendChild(this.canvas);
        if (this.canvasStyle === null) this.canvas.removeAttribute('style');
        else this.canvas.setAttribute('style', this.canvasStyle);
        this.root.remove();
        document.body.classList.remove('watch-console-open');
    }
}
