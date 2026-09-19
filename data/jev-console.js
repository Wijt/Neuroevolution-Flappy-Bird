// Judgment console for the Jev watch scene. Plain DOM + inline SVG, no libraries.
// The scene owns all game/network state; this module only renders what it is told and
// owns canvas placement (the scene's updateLayout()/restoreCanvasPosition() call into it).
//
// v4 contract: three yes/no (noul) questions per window - flap_now, flap_again, flap_later -
// composed in code with one threshold T. See docs/jev-design.md "v4: three yes/no
// judgments, one threshold".
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

    const PLANS = (root.JevPhysics && root.JevPhysics.PLANS) || ['no_flap', 'flap_now', 'flap_at_12', 'double_flap'];
    const PLAN_LABELS = Object.fromEntries(PLANS.map(p => [p, p.toUpperCase()]));

    // Maps a composed plan to the flap@0 / flap@12 graph nodes it lights up.
    const PLAN_FLAP_NODES = {
        no_flap: [],
        flap_now: ['f0'],
        flap_at_12: ['f12'],
        double_flap: ['f0', 'f12']
    };

    const QUESTION_IDS = ['flap_now', 'flap_again', 'flap_later'];
    const QUESTION_LABELS = { flap_now: 'flap now?', flap_again: 'flap again?', flap_later: 'flap later?' };

    const DEFAULT_THRESHOLD = 0.5;

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
            this._positionMarkers();
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
            const thLabel = el('label', { text: 'THRESHOLD', attrs: { for: 'jev-threshold-input' } });
            this.thresholdInput = el('input', {
                attrs: { type: 'number', id: 'jev-threshold-input', min: '0.05', max: '0.95', step: '0.05' }
            });
            this.thresholdInput.value = String(DEFAULT_THRESHOLD);
            this._loadStoredThreshold();
            this.thresholdInput.addEventListener('input', () => {
                this._saveStoredThreshold();
                this._positionMarkers();
            });
            const autoLabel = el('label', { className: 'jev-console-checkbox' });
            this.autoRestartInput = el('input', { attrs: { type: 'checkbox' } });
            autoLabel.appendChild(this.autoRestartInput);
            autoLabel.appendChild(document.createTextNode('AUTO'));
            row2.appendChild(capLabel);
            row2.appendChild(this.capInput);
            row2.appendChild(thLabel);
            row2.appendChild(this.thresholdInput);
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

            this.judgmentCards = {};
            QUESTION_IDS.forEach(id => { this.judgmentCards[id] = this._buildNoulCard(s, id); });

            this.lateNoteEl = el('div', { className: 'jev-console-late-note', text: 'no answer in time' });
            this.lateNoteEl.style.display = 'none';
            s.appendChild(this.lateNoteEl);

            return s;
        }

        _buildNoulCard(parent, id) {
            const card = el('div', { className: 'jev-console-card' });
            const head = el('div', { className: 'jev-console-card-head' });
            head.appendChild(el('span', { className: 'jev-console-tag', text: id.toUpperCase() }));
            card.appendChild(head);
            const instructionsEl = el('div', { className: 'jev-console-instructions', text: '' });
            card.appendChild(instructionsEl);
            const body = el('div', { className: 'jev-console-card-body' });
            const bar = this._buildNoulBar(body);
            card.appendChild(body);
            parent.appendChild(card);
            return { card, instructionsEl, bar };
        }

        _buildNoulBar(container) {
            const row = el('div', { className: 'jev-console-noul-row' });
            const track = el('span', { className: 'jev-console-bar-track jev-console-noul-track' });
            const fill = el('span', { className: 'jev-console-bar-fill' });
            const marker = el('span', { className: 'jev-console-bar-marker' });
            track.appendChild(fill);
            track.appendChild(marker);
            const pct = el('span', { className: 'jev-console-bar-pct', text: '—' });
            const verdict = el('span', { className: 'jev-console-verdict', text: '—' });
            row.appendChild(track);
            row.appendChild(pct);
            row.appendChild(verdict);
            container.appendChild(row);
            return { row, track, fill, marker, pct, verdict };
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
            this._syncJudgmentInstructions();
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

        _loadStoredThreshold() {
            try {
                const raw = localStorage.getItem('jev.threshold.v1');
                if (!raw) return;
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0.05 && n <= 0.95) this.thresholdInput.value = String(n);
            } catch (e) { /* ignore: localStorage unavailable or corrupt */ }
        }

        _saveStoredThreshold() {
            try { localStorage.setItem('jev.threshold.v1', String(this.getThreshold())); }
            catch (e) { /* ignore: localStorage unavailable */ }
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

        // Keeps the Judgments cards' instructions text in sync with the applied prompt
        // overrides (or the defaults, when nothing is overridden).
        _syncJudgmentInstructions() {
            if (!this.judgmentCards) return;
            QUESTION_IDS.forEach(id => {
                const card = this.judgmentCards[id];
                if (card) card.instructionsEl.textContent = this._instructionsFor(id);
            });
        }

        _instructionsFor(id) {
            const override = this.appliedPrompts && this.appliedPrompts.questions && this.appliedPrompts.questions[id];
            if (override && override.instructions) return override.instructions;
            const def = this.promptDefaults && this.promptDefaults.questions && this.promptDefaults.questions[id];
            return (def && def.instructions) || '';
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
        // 6 sensors -> state -> 3 questions -> YES/NO per question -> compose -> plan ->
        // flap@0 / flap@12 -> bird.

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

            const QY = { flap_now: 40, flap_again: 160, flap_later: 280 };
            QUESTION_IDS.forEach(id => {
                addNode('q-' + id, X.question, QY[id], QUESTION_LABELS[id]);
                addEdge('e-state-' + id, 'state', 'q-' + id);
            });

            QUESTION_IDS.forEach(id => {
                const y0 = QY[id];
                addNode('opt-' + id + '-yes', X.option, y0 - 16, 'YES');
                addNode('opt-' + id + '-no', X.option, y0 + 16, 'NO');
                addEdge('e-' + id + '-yes', 'q-' + id, 'opt-' + id + '-yes');
                addEdge('e-' + id + '-no', 'q-' + id, 'opt-' + id + '-no');
            });

            addNode('compose', X.compose, 160, 'compose');
            QUESTION_IDS.forEach(id => {
                ['yes', 'no'].forEach(k => addEdge('e-compose-' + id + '-' + k, 'opt-' + id + '-' + k, 'compose'));
            });

            addNode('plan', X.plan, 160, 'plan: —');
            addEdge('e-compose-plan', 'compose', 'plan');

            addNode('f0', X.flap, 120, 'flap@0');
            addNode('f12', X.flap, 200, 'flap@12');
            ['f0', 'f12'].forEach(f => addEdge('e-plan-' + f, 'plan', f));

            addNode('bird', X.bird, 160, 'bird');
            ['f0', 'f12'].forEach(f => addEdge('e-' + f + '-bird', f, 'bird'));
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

        _updateGraph(info, T) {
            this._resetGraphHighlights();
            const probs = info.probabilities || {};
            const late = !!info.late;
            const glowClass = late ? 'late' : 'active';

            QUESTION_IDS.forEach(id => {
                const hasP = Number.isFinite(probs[id]);
                const yesP = hasP ? Math.max(0, Math.min(1, probs[id])) : 0;
                const noP = hasP ? 1 - yesP : 0;
                const eYes = this.graphEdges['e-' + id + '-yes'];
                const eNo = this.graphEdges['e-' + id + '-no'];
                eYes.setAttribute('opacity', 0.15 + 0.85 * yesP);
                eYes.setAttribute('stroke-width', 1 + 4 * yesP);
                eNo.setAttribute('opacity', 0.15 + 0.85 * noP);
                eNo.setAttribute('stroke-width', 1 + 4 * noP);
                if (hasP) {
                    const chosen = yesP >= T ? 'yes' : 'no';
                    this.graphEdges['e-state-' + id].classList.add(glowClass);
                    this.graphNodes['q-' + id].g.classList.add(glowClass);
                    this.graphEdges['e-' + id + '-' + chosen].classList.add(glowClass);
                    this.graphEdges['e-compose-' + id + '-' + chosen].classList.add(glowClass);
                    this.graphNodes['opt-' + id + '-' + chosen].g.classList.add(glowClass);
                }
            });

            // compose -> plan -> flap nodes -> bird: always the active/final path (a plan
            // is chosen even on LATE, via the physics fallback).
            this.graphEdges['e-compose-plan'].classList.add(glowClass);
            this.graphNodes['compose'].g.classList.add(glowClass);
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

        // Number input, min 0.05, max 0.95, default 0.5 on anything invalid/out of range.
        getThreshold() {
            const n = Number(this.thresholdInput && this.thresholdInput.value);
            return Number.isFinite(n) && n >= 0.05 && n <= 0.95 ? n : DEFAULT_THRESHOLD;
        }

        _positionMarkers() {
            if (!this.judgmentCards) return;
            const pct = (this.getThreshold() * 100) + '%';
            QUESTION_IDS.forEach(id => {
                const card = this.judgmentCards[id];
                if (card) card.bar.marker.style.left = pct;
            });
        }

        setDecision(info) {
            this._decisionCount++;
            info = info || {};
            const late = !!info.late;
            const T = this.getThreshold();

            this.planNameEl.textContent = PLAN_LABELS[info.plan] || info.plan || '—';
            this.planNameEl.classList.toggle('jev-late', late);
            let badge = this.planNameEl.querySelector('.jev-console-late-badge');
            if (badge) badge.remove();
            if (late) {
                badge = el('span', { className: 'jev-console-late-badge', text: 'LATE' });
                this.planNameEl.appendChild(badge);
            }

            const probs = info.probabilities || {};
            this.lateNoteEl.style.display = late ? 'block' : 'none';

            QUESTION_IDS.forEach(id => {
                const card = this.judgmentCards[id];
                card.card.classList.toggle('dim', late);
                const hasP = Number.isFinite(probs[id]);
                const p = hasP ? Math.max(0, Math.min(1, probs[id])) : null;
                if (p === null) {
                    card.bar.fill.style.width = '0%';
                    card.bar.fill.classList.remove('chosen');
                    card.bar.pct.textContent = '—';
                    card.bar.verdict.textContent = '—';
                    card.bar.verdict.className = 'jev-console-verdict';
                } else {
                    const yes = p >= T;
                    card.bar.fill.style.width = (p * 100).toFixed(1) + '%';
                    card.bar.fill.classList.toggle('chosen', yes);
                    card.bar.pct.textContent = Math.round(p * 100) + '%';
                    card.bar.verdict.textContent = yes ? 'YES' : 'NO';
                    card.bar.verdict.className = 'jev-console-verdict ' + (yes ? 'yes' : 'no');
                }
                card.bar.marker.style.left = (T * 100) + '%';
            });

            this.dirLatEl.textContent = Number.isFinite(info.latencyAvg) ? Math.round(info.latencyAvg) + 'ms' : '—';

            this._updateGraph(info, T);
            this._updateStatusLine(info, T);
        }

        _updateStatusLine(info, T) {
            const probs = info.probabilities || {};
            const fmt = v => Number.isFinite(v) ? v.toFixed(2) : '—';
            const windowNo = Number.isFinite(info.index) ? info.index : this._decisionCount;
            this.statusLineEl.textContent =
                'PLAN: ' + (PLAN_LABELS[info.plan] || info.plan || '—') +
                ' · now ' + fmt(probs.flap_now) +
                ' · again ' + fmt(probs.flap_again) +
                ' · later ' + fmt(probs.flap_later) +
                ' · T ' + T.toFixed(2) +
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
