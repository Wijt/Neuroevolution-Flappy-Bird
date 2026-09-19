// Judgment console for the Jev watch scene. Plain DOM + inline SVG, no libraries.
// The scene owns all game/network state; this module only renders what it is told and
// owns canvas placement (the scene's updateLayout()/restoreCanvasPosition() call into it).
(function (root) {
    const SVGNS = 'http://www.w3.org/2000/svg';

    function el(tag, opts) {
        const node = document.createElement(tag);
        if (opts) {
            if (opts.className) node.className = opts.className;
            if (opts.text !== undefined) node.textContent = opts.text;
            if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
        }
        return node;
    }

    function svg(tag, attrs) {
        const node = document.createElementNS(SVGNS, tag);
        if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
        return node;
    }

    const PLANS = (root.JevPhysics && root.JevPhysics.PLANS) || ['flap_now', 'flap_at_8', 'flap_at_16', 'double_flap', 'triple_flap', 'no_flap'];
    const PLAN_LABELS = Object.fromEntries(PLANS.map(p => [p, p.toUpperCase()]));

    // Maps a composed plan to the flap@0 / flap@8 / flap@16 graph nodes it lights up.
    // (double_flap/triple_flap actually flap on more ticks than these three nodes cover;
    // this is a display simplification, see docs/jev-design.md GRAPH section.)
    const PLAN_FLAP_NODES = {
        no_flap: [],
        flap_now: ['f0'],
        flap_at_8: ['f8'],
        flap_at_16: ['f16'],
        double_flap: ['f0'],
        triple_flap: ['f0', 'f8', 'f16']
    };

    const CLIMB_OPTIONS = ['none', 'one_flap', 'two_flaps', 'three_flaps'];
    const TIMING_OPTIONS = ['now', 'soon', 'late'];
    const CLIMB_LABELS = { none: 'NONE', one_flap: '1 FLAP', two_flaps: '2 FLAPS', three_flaps: '3 FLAPS' };
    const TIMING_LABELS = { now: 'NOW', soon: 'SOON', late: 'LATE' };

    class JevConsole {
        constructor(callbacks) {
            this.callbacks = callbacks || {};
            this.root = el('div', { className: 'jev-console', attrs: { 'aria-label': 'Jev judgment console' } });

            this._buildGame();
            this._buildSide();
            this._buildStatusLine();
            this._buildGraphSection();

            document.body.appendChild(this.root);
            this._decisionCount = 0;
        }

        // ---- construction ----------------------------------------------------

        _buildGame() {
            const wrap = el('div', { className: 'jev-console-game' });
            this.gameFrame = el('div', { className: 'jev-console-game-frame' });
            wrap.appendChild(this.gameFrame);
            this.root.appendChild(wrap);
        }

        _buildSide() {
            const side = el('div', { className: 'jev-console-side' });
            side.appendChild(this._buildOrders());
            side.appendChild(this._buildDirector());
            side.appendChild(this._buildJudgments());
            side.appendChild(this._buildPrompts());
            side.appendChild(this._buildSitrep());
            side.appendChild(this._buildHistory());
            this.root.appendChild(side);
        }

        _sectionLabel(text) {
            return el('h2', { className: 'jev-console-label', text });
        }

        _buildOrders() {
            const s = el('section', { className: 'jev-console-panel' });
            s.appendChild(this._sectionLabel('Orders'));

            this.keyInput = el('input', {
                attrs: {
                    type: 'password', id: 'jev-key-input',
                    placeholder: 'TypeSafe API key — or set .env',
                    autocomplete: 'off', spellcheck: 'false'
                }
            });
            s.appendChild(this.keyInput);

            const row = el('div', { className: 'jev-console-row' });
            this.startButton = el('button', { text: 'Start' });
            this.startButton.addEventListener('click', () => this.callbacks.onStart && this.callbacks.onStart());
            this.menuButton = el('button', { text: 'Menu' });
            this.menuButton.addEventListener('click', () => this.callbacks.onMenu && this.callbacks.onMenu());
            this.logButton = el('button', { text: 'Copy log' });
            this.logButton.title = 'Copy every decision of this round as JSON (plan, Jev answers, sensor state, latency)';
            this.logButton.addEventListener('click', () => this.copyLog());
            row.appendChild(this.startButton);
            row.appendChild(this.menuButton);
            row.appendChild(this.logButton);
            s.appendChild(row);

            const row2 = el('div', { className: 'jev-console-row' });
            const capLabel = el('label', { text: 'CAP', attrs: { for: 'jev-cap-input' } });
            this.capInput = el('input', { attrs: { type: 'number', id: 'jev-cap-input', min: '0', step: '1' } });
            this.capInput.value = '3000';
            const autoLabel = el('label', { className: 'jev-console-checkbox' });
            this.autoRestartInput = el('input', { attrs: { type: 'checkbox' } });
            autoLabel.appendChild(this.autoRestartInput);
            autoLabel.appendChild(document.createTextNode('AUTO'));
            row2.appendChild(capLabel);
            row2.appendChild(this.capInput);
            row2.appendChild(autoLabel);
            s.appendChild(row2);

            this.statusEl = el('div', { className: 'jev-console-status', attrs: { role: 'status' } });
            s.appendChild(this.statusEl);

            this.errorEl = el('div', { className: 'jev-console-error' });
            this.errorEl.style.display = 'none';
            this.retryButton = el('button', { text: 'Retry' });
            this.retryButton.style.display = 'none';
            this.retryButton.addEventListener('click', () => this.callbacks.onRetry && this.callbacks.onRetry());
            s.appendChild(this.errorEl);
            s.appendChild(this.retryButton);

            return s;
        }

        _buildDirector() {
            const s = el('section', { className: 'jev-console-panel' });
            s.appendChild(this._sectionLabel('Director'));
            const grid = el('div', { className: 'jev-console-director-grid' });
            this.dirReqEl = this._metaCell(grid, 'REQ');
            this.dirLateEl = this._metaCell(grid, 'LATE');
            this.dirLatEl = this._metaCell(grid, 'LAT');
            this.dirCostEl = this._metaCell(grid, 'COST');
            this.dirAgreeEl = this._metaCell(grid, 'AGREE');
            s.appendChild(grid);
            return s;
        }

        _metaCell(grid, label) {
            const cell = el('div', { className: 'jev-console-meta-cell' });
            const b = el('b', { text: '—' });
            cell.appendChild(b);
            cell.appendChild(el('span', { text: label }));
            grid.appendChild(cell);
            return b;
        }

        _buildJudgments() {
            const s = el('section', { className: 'jev-console-panel' });
            s.appendChild(this._sectionLabel('Judgments'));

            this.planNameEl = el('div', { className: 'jev-console-plan-name', text: '—' });
            s.appendChild(this.planNameEl);

            this.dangerCard = this._buildJudgmentCard(s, 'Danger', 'Will you hit the bottom pipe or ground within half a second?');
            this.dangerCard.bar = this._buildBarRow(this.dangerCard.body, 'noul', 'YES');
            this.dangerCard.noText = el('span', { className: 'jev-console-noul', text: '—' });
            this.dangerCard.body.appendChild(this.dangerCard.noText);

            this.climbCard = this._buildJudgmentCard(s, 'Climb', 'How much height do you need in the next 0.4 s?');
            this.climbCard.bars = {};
            CLIMB_OPTIONS.forEach(k => { this.climbCard.bars[k] = this._buildBarRow(this.climbCard.body, k, CLIMB_LABELS[k]); });
            this.climbCard.confEl = el('div', { className: 'jev-console-conf', text: 'conf —' });
            this.climbCard.body.appendChild(this.climbCard.confEl);

            this.timingCard = this._buildJudgmentCard(s, 'Timing', 'If you flap once, when?');
            this.timingCard.bars = {};
            TIMING_OPTIONS.forEach(k => { this.timingCard.bars[k] = this._buildBarRow(this.timingCard.body, k, TIMING_LABELS[k]); });
            this.timingCard.confEl = el('div', { className: 'jev-console-conf', text: 'conf —' });
            this.timingCard.body.appendChild(this.timingCard.confEl);

            const metaGrid = el('div', { className: 'jev-console-director-grid' });
            this.confidenceEl = this._metaCell(metaGrid, 'CONF');
            this.latencyEl = this._metaCell(metaGrid, 'LAT L/A/P95');
            s.appendChild(metaGrid);

            return s;
        }

        _buildJudgmentCard(parent, tag, instructions) {
            const card = el('div', { className: 'jev-console-card' });
            const head = el('div', { className: 'jev-console-card-head' });
            head.appendChild(el('span', { className: 'jev-console-tag', text: tag.toUpperCase() }));
            card.appendChild(head);
            card.appendChild(el('div', { className: 'jev-console-instructions', text: instructions }));
            const body = el('div', { className: 'jev-console-card-body' });
            card.appendChild(body);
            parent.appendChild(card);
            return { card, body };
        }

        _buildBarRow(container, key, label) {
            const row = el('div', { className: 'jev-console-bar-row' });
            const lbl = el('span', { className: 'jev-console-bar-label', text: label });
            const track = el('span', { className: 'jev-console-bar-track' });
            const fill = el('span', { className: 'jev-console-bar-fill' });
            track.appendChild(fill);
            const pct = el('span', { className: 'jev-console-bar-pct', text: '0%' });
            row.appendChild(lbl);
            row.appendChild(track);
            row.appendChild(pct);
            container.appendChild(row);
            return { row, lbl, fill, pct };
        }

        // ---- prompts (live-editable texts sent to Jev) --------------------------

        _buildPrompts() {
            const s = el('section', { className: 'jev-console-panel' });
            const details = el('details', { className: 'jev-console-prompts' });
            details.appendChild(el('summary', { text: 'PROMPTS · edit what Jev reads' }));
            const body = el('div', { className: 'jev-console-prompts-body' });
            details.appendChild(body);
            s.appendChild(details);

            this.promptDefaults = (root.JevContract && root.JevContract.defaultPrompts)
                ? root.JevContract.defaultPrompts()
                : { game: '', questions: {} };
            this.promptFields = {};
            this.appliedPrompts = null;

            body.appendChild(this._promptLabel('game'));
            this.promptFields.game = this._promptField(body, 'game', this.promptDefaults.game, false);

            for (const qid in this.promptDefaults.questions) {
                const q = this.promptDefaults.questions[qid];
                body.appendChild(this._promptLabel(qid.toUpperCase() + ' · instructions'));
                this.promptFields[qid + '.instructions'] = this._promptField(body, qid + '.instructions', q.instructions, false);
                if (q.criteria) {
                    for (const key in q.criteria) {
                        const path = qid + '.criteria.' + key;
                        body.appendChild(this._promptLabel(qid.toUpperCase() + '.' + key));
                        this.promptFields[path] = this._promptField(body, path, q.criteria[key], true);
                    }
                }
            }

            const row = el('div', { className: 'jev-console-row' });
            this.promptApplyButton = el('button', { text: 'Apply' });
            this.promptApplyButton.addEventListener('click', () => this._applyPrompts());
            this.promptResetButton = el('button', { text: 'Reset' });
            this.promptResetButton.addEventListener('click', () => this._resetPrompts());
            row.appendChild(this.promptApplyButton);
            row.appendChild(this.promptResetButton);
            body.appendChild(row);

            this.promptStatusEl = el('div', { className: 'jev-console-status', text: '' });
            body.appendChild(this.promptStatusEl);

            this.promptTokenEl = el('div', { className: 'jev-console-conf', text: '' });
            body.appendChild(this.promptTokenEl);

            this._loadStoredPrompts();
            this._applyPrompts(true);

            return s;
        }

        _promptLabel(text) {
            return el('div', { className: 'jev-console-prompt-label', text });
        }

        _promptField(container, path, value, small) {
            const ta = el('textarea', {
                className: 'jev-console-prompt-field' + (small ? ' jev-console-prompt-field-small' : ''),
                attrs: { rows: small ? '2' : '4', spellcheck: 'false' }
            });
            ta.value = value || '';
            ta.addEventListener('input', () => this._markModified(path));
            container.appendChild(ta);
            return ta;
        }

        _defaultAt(path) {
            if (path === 'game') return this.promptDefaults.game || '';
            const parts = path.split('.');
            const q = this.promptDefaults.questions[parts[0]];
            if (!q) return '';
            if (parts[1] === 'instructions') return q.instructions || '';
            if (parts[1] === 'criteria') return (q.criteria && q.criteria[parts[2]]) || '';
            return '';
        }

        _markModified(path) {
            const ta = this.promptFields[path];
            if (!ta) return;
            const modified = ta.value.trim() !== this._defaultAt(path).trim();
            ta.classList.toggle('jev-console-prompt-modified', modified);
        }

        _refreshModifiedMarks() {
            for (const path in this.promptFields) this._markModified(path);
        }

        _collectPrompts() {
            const out = { game: this.promptFields.game.value.trim(), questions: {} };
            for (const qid in this.promptDefaults.questions) {
                const q = this.promptDefaults.questions[qid];
                out.questions[qid] = { instructions: this.promptFields[qid + '.instructions'].value.trim() };
                if (q.criteria) {
                    out.questions[qid].criteria = {};
                    for (const key in q.criteria) {
                        out.questions[qid].criteria[key] = this.promptFields[qid + '.criteria.' + key].value.trim();
                    }
                }
            }
            return out;
        }

        _promptsEqualDefaults(p) {
            if (p.game.trim() !== (this.promptDefaults.game || '').trim()) return false;
            for (const qid in this.promptDefaults.questions) {
                const q = this.promptDefaults.questions[qid];
                if ((p.questions[qid].instructions || '').trim() !== (q.instructions || '').trim()) return false;
                if (q.criteria) {
                    for (const key in q.criteria) {
                        if ((p.questions[qid].criteria[key] || '').trim() !== (q.criteria[key] || '').trim()) return false;
                    }
                }
            }
            return true;
        }

        _applyPrompts(silent) {
            const collected = this._collectPrompts();
            const modified = !this._promptsEqualDefaults(collected);
            this.appliedPrompts = modified ? collected : null;
            this._saveStoredPrompts(this.appliedPrompts);
            this._refreshModifiedMarks();
            this._updateTokenEstimate();
            if (!silent && this.promptStatusEl) {
                this.promptStatusEl.textContent = 'applied · next request';
                if (this._promptStatusTimer) clearTimeout(this._promptStatusTimer);
                this._promptStatusTimer = setTimeout(() => { this.promptStatusEl.textContent = ''; }, 2500);
            }
        }

        _resetPrompts() {
            this.promptFields.game.value = this.promptDefaults.game || '';
            for (const qid in this.promptDefaults.questions) {
                const q = this.promptDefaults.questions[qid];
                this.promptFields[qid + '.instructions'].value = q.instructions || '';
                if (q.criteria) {
                    for (const key in q.criteria) {
                        this.promptFields[qid + '.criteria.' + key].value = q.criteria[key] || '';
                    }
                }
            }
            this._applyPrompts();
        }

        _loadStoredPrompts() {
            try {
                const raw = localStorage.getItem('jev.prompts.v1');
                if (!raw) return;
                const stored = JSON.parse(raw);
                if (!stored || typeof stored !== 'object') return;
                if (typeof stored.game === 'string') this.promptFields.game.value = stored.game;
                const oq = stored.questions && typeof stored.questions === 'object' ? stored.questions : {};
                for (const qid in this.promptDefaults.questions) {
                    const o = oq[qid];
                    if (!o || typeof o !== 'object') continue;
                    if (typeof o.instructions === 'string') this.promptFields[qid + '.instructions'].value = o.instructions;
                    const q = this.promptDefaults.questions[qid];
                    if (q.criteria && o.criteria && typeof o.criteria === 'object') {
                        for (const key in q.criteria) {
                            if (typeof o.criteria[key] === 'string') this.promptFields[qid + '.criteria.' + key].value = o.criteria[key];
                        }
                    }
                }
            } catch (e) { /* ignore: localStorage unavailable or corrupt */ }
        }

        _saveStoredPrompts(prompts) {
            try {
                if (prompts) localStorage.setItem('jev.prompts.v1', JSON.stringify(prompts));
                else localStorage.removeItem('jev.prompts.v1');
            } catch (e) { /* ignore: localStorage unavailable */ }
        }

        _updateTokenEstimate() {
            if (!this.promptTokenEl) return;
            if (!root.JevContract || !root.JevContract.buildRequest) { this.promptTokenEl.textContent = ''; return; }
            const sampleState = {
                bird: { x: 100, y: 300, velocity: 0, radius: 15 },
                world: { width: 450, groundY: 750 },
                physics: { gravity: 0.4, jumpPower: 6, pipeSpeed: 2 },
                pipes: [{ left: 400, right: 450, gapTop: 260, gapBottom: 385 }]
            };
            try {
                const request = root.JevContract.buildRequest(sampleState, 'jev-latest', this.appliedPrompts);
                const tokens = Math.round(JSON.stringify(request).length / 4);
                this.promptTokenEl.textContent = '≈ ' + tokens + ' tokens';
            } catch (e) {
                this.promptTokenEl.textContent = '';
            }
        }

        // Returns the console-edited prompts object (see jev-contract.js resolvePrompts),
        // or null when nothing differs from the defaults, so the request stays default-sized.
        getPrompts() {
            return this.appliedPrompts;
        }

        _buildSitrep() {
            const s = el('section', { className: 'jev-console-panel' });
            s.appendChild(this._sectionLabel('Situation Report'));
            this.sitrepList = el('div', { className: 'jev-console-sitrep' });
            s.appendChild(this.sitrepList);

            const reqDetails = el('details');
            reqDetails.appendChild(el('summary', { text: 'raw request' }));
            this.requestPre = el('pre', { text: '(none yet)' });
            reqDetails.appendChild(this.requestPre);
            const resDetails = el('details');
            resDetails.appendChild(el('summary', { text: 'raw response' }));
            this.responsePre = el('pre', { text: '(none yet)' });
            resDetails.appendChild(this.responsePre);
            s.appendChild(reqDetails);
            s.appendChild(resDetails);

            return s;
        }

        _buildHistory() {
            const s = el('section', { className: 'jev-console-panel' });
            const details = el('details');
            details.appendChild(el('summary', { text: 'HISTORY' }));
            this.historyList = el('ul', { className: 'jev-console-history' });
            details.appendChild(this.historyList);
            s.appendChild(details);
            return s;
        }

        _buildStatusLine() {
            this.statusLineEl = el('div', { className: 'jev-console-status-line', text: '—' });
            this.root.appendChild(this.statusLineEl);
        }

        _buildGraphSection() {
            const wrap = el('div', { className: 'jev-console-graph' });
            wrap.appendChild(this._sectionLabel('Graph'));
            this.graphSvg = svg('svg', { viewBox: '0 0 1200 320', preserveAspectRatio: 'xMidYMid meet', class: 'jev-console-graph-svg' });
            wrap.appendChild(this.graphSvg);
            this.root.appendChild(wrap);
            this._buildGraph();
        }

        // ---- graph -------------------------------------------------------------

        _buildGraph() {
            this.graphNodes = {};
            this.graphEdges = {};

            const addNode = (id, x, y, label) => {
                const g = svg('g', { class: 'jev-graph-node', 'data-id': id });
                const rect = svg('rect', { x: x - 44, y: y - 12, width: 88, height: 24, rx: 3 });
                const text = svg('text', { x, y: y + 4, 'text-anchor': 'middle' });
                text.textContent = label;
                g.appendChild(rect);
                g.appendChild(text);
                this.graphSvg.appendChild(g);
                this.graphNodes[id] = { g, rect, text, x, y };
                return this.graphNodes[id];
            };

            const addEdge = (id, from, to) => {
                const a = this.graphNodes[from], b = this.graphNodes[to];
                const path = svg('path', {
                    class: 'jev-graph-edge',
                    d: `M${a.x + 44},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x - 44},${b.y}`
                });
                this.graphSvg.appendChild(path);
                this.graphEdges[id] = path;
                return path;
            };

            // Column x-positions.
            const X = { sensor: 60, state: 220, question: 380, option: 580, compose: 780, plan: 900, flap: 1030, bird: 1150 };

            addNode('you', X.sensor, 30, 'you: —');
            addNode('hole', X.sensor, 80, 'hole: —');
            addNode('pipe', X.sensor, 130, 'pipe: —');
            addNode('rayUp', X.sensor, 180, 'ray ↑: —');
            addNode('rayFwd', X.sensor, 230, 'ray →: —');
            addNode('rayDown', X.sensor, 280, 'ray ↓: —');

            addNode('state', X.state, 160, 'state');
            ['you', 'hole', 'pipe', 'rayUp', 'rayFwd', 'rayDown'].forEach(s => addEdge('e-' + s, s, 'state'));

            addNode('qDanger', X.question, 40, 'danger?');
            addNode('qClimb', X.question, 160, 'climb?');
            addNode('qTiming', X.question, 280, 'timing?');
            addEdge('e-state-danger', 'state', 'qDanger');
            addEdge('e-state-climb', 'state', 'qClimb');
            addEdge('e-state-timing', 'state', 'qTiming');

            const dangerOpts = ['yes', 'no'];
            dangerOpts.forEach((k, i) => addNode('opt-danger-' + k, X.option, 20 + i * 32, k.toUpperCase()));
            dangerOpts.forEach(k => addEdge('e-danger-' + k, 'qDanger', 'opt-danger-' + k));

            CLIMB_OPTIONS.forEach((k, i) => addNode('opt-climb-' + k, X.option, 100 + i * 32, CLIMB_LABELS[k]));
            CLIMB_OPTIONS.forEach(k => addEdge('e-climb-' + k, 'qClimb', 'opt-climb-' + k));

            TIMING_OPTIONS.forEach((k, i) => addNode('opt-timing-' + k, X.option, 240 + i * 32, TIMING_LABELS[k]));
            TIMING_OPTIONS.forEach(k => addEdge('e-timing-' + k, 'qTiming', 'opt-timing-' + k));

            addNode('compose', X.compose, 160, 'compose');
            dangerOpts.forEach(k => addEdge('e-compose-danger-' + k, 'opt-danger-' + k, 'compose'));
            CLIMB_OPTIONS.forEach(k => addEdge('e-compose-climb-' + k, 'opt-climb-' + k, 'compose'));
            TIMING_OPTIONS.forEach(k => addEdge('e-compose-timing-' + k, 'opt-timing-' + k, 'compose'));

            addNode('plan', X.plan, 160, 'plan: —');
            addEdge('e-compose-plan', 'compose', 'plan');

            addNode('f0', X.flap, 100, 'flap@0');
            addNode('f8', X.flap, 160, 'flap@8');
            addNode('f16', X.flap, 220, 'flap@16');
            ['f0', 'f8', 'f16'].forEach(f => addEdge('e-plan-' + f, 'plan', f));

            addNode('bird', X.bird, 160, 'bird');
            ['f0', 'f8', 'f16'].forEach(f => addEdge('e-' + f + '-bird', f, 'bird'));
        }

        _resetGraphHighlights() {
            for (const id in this.graphEdges) {
                const e = this.graphEdges[id];
                e.classList.remove('active', 'late');
                e.setAttribute('stroke-width', 1);
                e.setAttribute('opacity', 0.25);
            }
            for (const id in this.graphNodes) {
                this.graphNodes[id].g.classList.remove('active', 'late');
            }
        }

        _updateGraph(info) {
            this._resetGraphHighlights();
            const answers = info.answers;
            const late = !!info.late;
            const glowClass = late ? 'late' : 'active';

            if (answers && answers.danger) {
                const yesP = Math.max(0, Math.min(1, Number(answers.danger.noul) || 0));
                const probs = { yes: yesP, no: 1 - yesP };
                ['yes', 'no'].forEach(k => {
                    const e = this.graphEdges['e-danger-' + k];
                    e.setAttribute('opacity', 0.15 + 0.85 * probs[k]);
                    e.setAttribute('stroke-width', 1 + 4 * probs[k]);
                });
                const chosen = yesP >= 0.5 ? 'yes' : 'no';
                this.graphEdges['e-danger-' + chosen].classList.add(glowClass);
                this.graphEdges['e-compose-danger-' + chosen].classList.add(glowClass);
                this.graphNodes['opt-danger-' + chosen].g.classList.add(glowClass);
            }

            if (answers && answers.climb) {
                const probs = answers.climb.probabilities || {};
                CLIMB_OPTIONS.forEach(k => {
                    const p = Math.max(0, Math.min(1, probs[k] || 0));
                    const e = this.graphEdges['e-climb-' + k];
                    e.setAttribute('opacity', 0.15 + 0.85 * p);
                    e.setAttribute('stroke-width', 1 + 4 * p);
                });
                const chosen = answers.climb.choice;
                if (this.graphEdges['e-climb-' + chosen]) {
                    this.graphEdges['e-climb-' + chosen].classList.add(glowClass);
                    this.graphEdges['e-compose-climb-' + chosen].classList.add(glowClass);
                    this.graphNodes['opt-climb-' + chosen].g.classList.add(glowClass);
                }
            }

            if (answers && answers.timing) {
                const probs = answers.timing.probabilities || {};
                TIMING_OPTIONS.forEach(k => {
                    const p = Math.max(0, Math.min(1, probs[k] || 0));
                    const e = this.graphEdges['e-timing-' + k];
                    e.setAttribute('opacity', 0.15 + 0.85 * p);
                    e.setAttribute('stroke-width', 1 + 4 * p);
                });
                const chosen = answers.timing.choice;
                const climbIsOneFlap = answers.climb && answers.climb.choice === 'one_flap';
                if (climbIsOneFlap && this.graphEdges['e-timing-' + chosen]) {
                    this.graphEdges['e-timing-' + chosen].classList.add(glowClass);
                    this.graphEdges['e-compose-timing-' + chosen].classList.add(glowClass);
                    this.graphNodes['opt-timing-' + chosen].g.classList.add(glowClass);
                }
            }

            // compose -> plan -> flap nodes -> bird: always the active/final path.
            this.graphEdges['e-compose-plan'].classList.add(glowClass);
            this.graphNodes['plan'].g.classList.add(glowClass);
            this.graphNodes['plan'].text.textContent = 'plan: ' + (PLAN_LABELS[info.plan] || info.plan || '—');

            const litFlaps = PLAN_FLAP_NODES[info.plan] || [];
            litFlaps.forEach(f => {
                this.graphEdges['e-plan-' + f].classList.add(glowClass);
                this.graphEdges['e-' + f + '-bird'].classList.add(glowClass);
                this.graphNodes[f].g.classList.add(glowClass);
            });
            if (litFlaps.length) this.graphNodes['bird'].g.classList.add(glowClass);
        }

        _updateGraphSensors(state) {
            if (!state) return;
            const set = (id, text) => { if (this.graphNodes[id]) this.graphNodes[id].text.textContent = text; };
            if (state.you) set('you', 'you: ' + state.you);
            if (state.hole) set('hole', 'hole: ' + this._truncate(state.hole));
            if (state.pipe) set('pipe', 'pipe: ' + this._truncate(state.pipe));
            const rays = state.rays || {};
            if (rays['straight ahead']) set('rayFwd', 'ray →: ' + this._truncate(rays['straight ahead']));
            if (rays['ahead and up']) set('rayUp', 'ray ↑: ' + this._truncate(rays['ahead and up']));
            if (rays['ahead and down']) set('rayDown', 'ray ↓: ' + this._truncate(rays['ahead and down']));
        }

        _truncate(text, max) {
            max = max || 18;
            const s = String(text);
            return s.length > max ? s.slice(0, max - 1) + '…' : s;
        }

        // ---- public API used by WatchScene -------------------------------------

        setStatus(message) {
            this.statusEl.textContent = message || '';
        }

        setStartButtonLabel(text) {
            this.startButton.textContent = text;
        }

        setStartButtonEnabled(enabled) {
            this.startButton.disabled = !enabled;
        }

        showError(message) {
            this.errorEl.textContent = message;
            this.errorEl.style.display = 'block';
            this.retryButton.style.display = 'inline-block';
        }

        clearError() {
            this.errorEl.textContent = '';
            this.errorEl.style.display = 'none';
            this.retryButton.style.display = 'none';
        }

        getApiKey() {
            return this.keyInput.value.trim();
        }

        clearApiKey() {
            this.keyInput.value = '';
        }

        getCap() {
            const n = Number(this.capInput.value);
            return Number.isFinite(n) && n >= 0 ? n : 0;
        }

        getAutoRestart() {
            return !!this.autoRestartInput.checked;
        }

        setDecision(info) {
            this._decisionCount++;
            info = info || {};
            const late = !!info.late;

            this.planNameEl.textContent = PLAN_LABELS[info.plan] || info.plan || '—';
            this.planNameEl.classList.toggle('jev-late', late);
            let badge = this.planNameEl.querySelector('.jev-console-late-badge');
            if (badge) badge.remove();
            if (late) {
                badge = el('span', { className: 'jev-console-late-badge', text: 'LATE' });
                this.planNameEl.appendChild(badge);
            }

            const answers = info.answers;

            // Danger card.
            if (answers && answers.danger) {
                const yesP = Math.max(0, Math.min(1, Number(answers.danger.noul) || 0));
                this.dangerCard.bar.fill.style.width = (yesP * 100).toFixed(1) + '%';
                this.dangerCard.bar.fill.classList.toggle('chosen', yesP >= 0.5);
                this.dangerCard.bar.pct.textContent = Math.round(yesP * 100) + '%';
                this.dangerCard.noText.textContent = yesP >= 0.5 ? 'YES' : 'NO';
            } else {
                this.dangerCard.bar.fill.style.width = '0%';
                this.dangerCard.bar.pct.textContent = '—';
                this.dangerCard.noText.textContent = '—';
            }

            // Climb / timing cards.
            this._fillJudgmentCard(this.climbCard, CLIMB_OPTIONS, answers && answers.climb);
            this._fillJudgmentCard(this.timingCard, TIMING_OPTIONS, answers && answers.timing);

            this.confidenceEl.textContent = Number.isFinite(info.confidence) ? Math.round(info.confidence * 100) + '%' : '—';
            this.latencyEl.textContent =
                (Number.isFinite(info.latencyMs) ? Math.round(info.latencyMs) : '—') + '/' +
                (Number.isFinite(info.latencyAvg) ? Math.round(info.latencyAvg) : '—') + '/' +
                (Number.isFinite(info.latencyP95) ? Math.round(info.latencyP95) : '—');

            this.dirLatEl.textContent = Number.isFinite(info.latencyAvg) ? Math.round(info.latencyAvg) + 'ms' : '—';

            this._updateGraph(info);
            this._updateStatusLine(info);
        }

        _fillJudgmentCard(card, options, answer) {
            const probs = (answer && answer.probabilities) || {};
            const chosen = answer && answer.choice;
            options.forEach(k => {
                const bar = card.bars[k];
                const p = Math.max(0, Math.min(1, probs[k] || 0));
                bar.fill.style.width = (p * 100).toFixed(1) + '%';
                bar.fill.classList.toggle('chosen', k === chosen);
                bar.lbl.classList.toggle('chosen', k === chosen);
                bar.pct.textContent = Math.round(p * 100) + '%';
            });
            card.confEl.textContent = 'conf ' + (answer && Number.isFinite(answer.confidence) ? answer.confidence.toFixed(2) : '—');
        }

        _updateStatusLine(info) {
            const answers = info.answers;
            const climb = answers && answers.climb ? CLIMB_LABELS[answers.climb.choice] || answers.climb.choice : '—';
            const climbP = answers && answers.climb && Number.isFinite(answers.climb.probabilities && answers.climb.probabilities[answers.climb.choice])
                ? answers.climb.probabilities[answers.climb.choice].toFixed(2) : '—';
            const dangerP = answers && answers.danger && Number.isFinite(answers.danger.noul) ? answers.danger.noul.toFixed(2) : '—';
            const windowNo = Number.isFinite(info.index) ? info.index : this._decisionCount;
            this.statusLineEl.textContent =
                'GOAL: ' + climb + ' · CLIMB ' + climbP + ' · DANGER ' + dangerP +
                ' · #' + windowNo + (info.late ? ' LATE' : '');
            this.statusLineEl.classList.toggle('jev-late', !!info.late);
        }

        setComparison(physicsBest, agreePct) {
            this.dirAgreeEl.textContent = Number.isFinite(agreePct) ? agreePct.toFixed(0) + '%' : '—';
            this.dirAgreeEl.title = 'physics would pick: ' + (PLAN_LABELS[physicsBest] || physicsBest || '—');
        }

        setUsage(u) {
            u = u || {};
            this.dirReqEl.textContent = String(u.requests || 0);
            this.dirLateEl.textContent = Number.isFinite(u.onTimePct) ? (100 - u.onTimePct).toFixed(0) + '%' : '—';
            this.dirCostEl.textContent = '$' + (Number(u.cost) || 0).toFixed(6);
        }

        setLastExchange(request, response) {
            try { this.requestPre.textContent = JSON.stringify(request, null, 2); } catch (e) { this.requestPre.textContent = String(request); }
            try { this.responsePre.textContent = JSON.stringify(response, null, 2); } catch (e) { this.responsePre.textContent = String(response); }

            this.sitrepList.innerHTML = '';
            const state = request && request.state;
            if (state) {
                for (const key in state) {
                    if (key === 'rays' && state.rays && typeof state.rays === 'object') {
                        for (const rk in state.rays) {
                            this.sitrepList.appendChild(this._sitrepLine(rk, state.rays[rk]));
                        }
                    } else {
                        this.sitrepList.appendChild(this._sitrepLine(key, state[key]));
                    }
                }
                this._updateGraphSensors(state);
            }
        }

        _sitrepLine(key, value) {
            const row = el('div', { className: 'jev-console-sitrep-row' });
            row.appendChild(el('span', { className: 'jev-console-sitrep-key', text: key + ':' }));
            row.appendChild(el('span', { className: 'jev-console-sitrep-val', text: String(value) }));
            return row;
        }

        // Full decision records (set by the scene) for the Copy log button.
        setLog(records) { this.logRecords = records || []; }

        copyLog() {
            const text = JSON.stringify(this.logRecords || [], null, 1);
            const done = () => { this.logButton.textContent = 'Copied'; setTimeout(() => { this.logButton.textContent = 'Copy log'; }, 1500); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => this._fallbackCopy(text, done));
            else this._fallbackCopy(text, done);
        }

        _fallbackCopy(text, done) {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); } catch (e) { /* ignore */ }
            ta.remove(); done();
        }

        setHistory(entries) {
            this.historyList.innerHTML = '';
            (entries || []).slice(-10).reverse().forEach(entry => {
                const li = el('li', {
                    text: '#' + entry.index + ' ' + (PLAN_LABELS[entry.plan] || entry.plan) +
                        ' p=' + (Number.isFinite(entry.probability) ? entry.probability.toFixed(2) : '?') +
                        ' lat=' + (Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : '?') + 'ms' +
                        (entry.late ? ' LATE' : '')
                });
                this.historyList.appendChild(li);
            });
        }

        // `rect` = {left, top, width, height} of the canvas in document coordinates
        // (unused for grid placement, kept for signature compatibility). `wide` toggles
        // the side-by-side vs stacked layout.
        layout(rect, wide) {
            document.body.classList.toggle('jev-console-wide', wide);
            document.body.classList.toggle('jev-console-narrow', !wide);
        }

        // Returns the DOM node the scene should move the p5 canvas into.
        getGameFrame() {
            return this.gameFrame;
        }

        destroy() {
            document.body.classList.remove('jev-console-open', 'jev-console-wide', 'jev-console-narrow');
            if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = JevConsole;
    else root.JevConsole = JevConsole;
})(typeof window !== 'undefined' ? window : globalThis);
