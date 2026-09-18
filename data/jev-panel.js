// Plain-DOM instrumentation panel for the Jev watch scene. No libraries, no framework.
// The scene owns all game/network state; this module only renders what it is told.
(function (root) {
    function el(tag, opts) {
        const node = document.createElement(tag);
        if (opts) {
            if (opts.className) node.className = opts.className;
            if (opts.text !== undefined) node.textContent = opts.text;
            if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
        }
        return node;
    }

    const PLANS = (root.JevPhysics && root.JevPhysics.PLANS) || ['flap_now', 'flap_at_8', 'flap_at_16', 'no_flap'];
    const PLAN_LABELS = Object.fromEntries(PLANS.map(p => [p, p]));

    class JevPanel {
        constructor(callbacks) {
            this.callbacks = callbacks || {};
            this.root = el('aside', { className: 'jev-panel', attrs: { 'aria-label': 'Jev instrumentation panel' } });

            this._buildSession();
            this._buildDecision();
            this._buildComparison();
            this._buildUsage();
            this._buildInspector();
            this._buildHistory();

            document.body.appendChild(this.root);
        }

        _buildSession() {
            const s = el('section');
            s.appendChild(el('h2', { text: 'Session' }));

            const keyLabel = el('label', { text: 'TypeSafe API key', attrs: { for: 'jev-key-input' } });
            this.keyInput = el('input', {
                attrs: {
                    type: 'password', id: 'jev-key-input',
                    placeholder: 'TypeSafe API key — or set .env',
                    autocomplete: 'off', spellcheck: 'false'
                }
            });
            s.appendChild(keyLabel);
            s.appendChild(this.keyInput);

            const capLabel = el('label', { text: 'Request cap (0 = unlimited)', attrs: { for: 'jev-cap-input' } });
            this.capInput = el('input', { attrs: { type: 'number', id: 'jev-cap-input', min: '0', step: '1' } });
            this.capInput.value = '3000';
            s.appendChild(capLabel);
            s.appendChild(this.capInput);

            const autoRow = el('label');
            this.autoRestartInput = el('input', { attrs: { type: 'checkbox' } });
            autoRow.appendChild(this.autoRestartInput);
            autoRow.appendChild(document.createTextNode('Auto restart after death'));
            s.appendChild(autoRow);

            const buttonRow = el('div');
            this.startButton = el('button', { text: 'Start' });
            this.startButton.addEventListener('click', () => this.callbacks.onStart && this.callbacks.onStart());
            this.menuButton = el('button', { text: 'Menu' });
            this.menuButton.addEventListener('click', () => this.callbacks.onMenu && this.callbacks.onMenu());
            buttonRow.appendChild(this.startButton);
            buttonRow.appendChild(this.menuButton);
            s.appendChild(buttonRow);

            this.statusEl = el('div', { className: 'jev-status', attrs: { role: 'status' } });
            s.appendChild(this.statusEl);

            this.errorEl = el('div', { className: 'jev-error' });
            this.errorEl.style.display = 'none';
            this.retryButton = el('button', { text: 'Retry' });
            this.retryButton.style.display = 'none';
            this.retryButton.addEventListener('click', () => this.callbacks.onRetry && this.callbacks.onRetry());
            s.appendChild(this.errorEl);
            s.appendChild(this.retryButton);

            this.root.appendChild(s);
        }

        _buildDecision() {
            const s = el('section');
            s.appendChild(el('h2', { text: 'Jev decision' }));
            this.planNameEl = el('div', { className: 'jev-plan-name', text: '—' });
            s.appendChild(this.planNameEl);

            this.barRows = {};
            PLANS.forEach(plan => {
                const row = el('div', { className: 'jev-bar-row' });
                const label = el('span', { className: 'jev-bar-label', text: PLAN_LABELS[plan] });
                const track = el('span', { className: 'jev-bar-track' });
                const fill = el('span', { className: 'jev-bar-fill' });
                track.appendChild(fill);
                const pct = el('span', { className: 'jev-bar-pct', text: '0%' });
                row.appendChild(label);
                row.appendChild(track);
                row.appendChild(pct);
                s.appendChild(row);
                this.barRows[plan] = { row, fill, pct };
            });

            const metaGrid = el('div', { className: 'jev-meta-grid' });
            this.confidenceEl = el('div');
            this.confidenceEl.appendChild(el('b', { text: '—' }));
            this.confidenceEl.appendChild(document.createTextNode('confidence'));
            this.latencyEl = el('div');
            this.latencyEl.appendChild(el('b', { text: '—' }));
            this.latencyEl.appendChild(document.createTextNode('latency (last / avg / p95)'));
            metaGrid.appendChild(this.confidenceEl);
            metaGrid.appendChild(this.latencyEl);
            s.appendChild(metaGrid);

            this.root.appendChild(s);
        }

        _buildComparison() {
            const s = el('section');
            s.appendChild(el('h2', { text: 'Physics comparison' }));
            this.physicsBestEl = el('div', { text: 'physics would pick: —' });
            this.agreeEl = el('div', { text: 'agreement: —' });
            s.appendChild(this.physicsBestEl);
            s.appendChild(this.agreeEl);
            this.root.appendChild(s);
        }

        _buildUsage() {
            const s = el('section');
            s.appendChild(el('h2', { text: 'Usage' }));
            const grid = el('div', { className: 'jev-meta-grid' });
            this.usageRequestsEl = this._metaCell(grid, 'requests sent');
            this.usageOnTimeEl = this._metaCell(grid, 'on-time %');
            this.usageTokensEl = this._metaCell(grid, 'tokens in / out');
            this.usageCostEl = this._metaCell(grid, 'estimated cost');
            this.usageRateEl = this._metaCell(grid, 'req/s');
            s.appendChild(grid);
            this.root.appendChild(s);
        }

        _metaCell(grid, label) {
            const cell = el('div');
            const b = el('b', { text: '—' });
            cell.appendChild(b);
            cell.appendChild(document.createTextNode(label));
            grid.appendChild(cell);
            return b;
        }

        _buildInspector() {
            const s = el('section');
            s.appendChild(el('h2', { text: 'Last request / response' }));
            const reqDetails = el('details');
            reqDetails.appendChild(el('summary', { text: 'Request' }));
            this.requestPre = el('pre', { text: '(none yet)' });
            reqDetails.appendChild(this.requestPre);
            const resDetails = el('details');
            resDetails.appendChild(el('summary', { text: 'Response' }));
            this.responsePre = el('pre', { text: '(none yet)' });
            resDetails.appendChild(this.responsePre);
            s.appendChild(reqDetails);
            s.appendChild(resDetails);
            this.root.appendChild(s);
        }

        _buildHistory() {
            const s = el('section');
            s.appendChild(el('h2', { text: 'History' }));
            this.historyList = el('ul', { className: 'jev-history' });
            s.appendChild(this.historyList);
            this.root.appendChild(s);
        }

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
            this.planNameEl.textContent = PLAN_LABELS[info.plan] || info.plan;
            const probs = info.probabilities || {};
            for (const plan in this.barRows) {
                const { fill, pct } = this.barRows[plan];
                const p = Math.max(0, Math.min(1, probs[plan] || 0));
                fill.style.width = (p * 100).toFixed(1) + '%';
                fill.classList.toggle('chosen', plan === info.plan);
                pct.textContent = Math.round(p * 100) + '%';
            }
            this.confidenceEl.querySelector('b').textContent =
                Number.isFinite(info.confidence) ? Math.round(info.confidence * 100) + '%' : '—';
            this.latencyEl.querySelector('b').textContent =
                (Number.isFinite(info.latencyMs) ? Math.round(info.latencyMs) : '—') + ' / ' +
                (Number.isFinite(info.latencyAvg) ? Math.round(info.latencyAvg) : '—') + ' / ' +
                (Number.isFinite(info.latencyP95) ? Math.round(info.latencyP95) : '—') + ' ms';

            let name = this.planNameEl;
            const existingBadge = name.querySelector('.jev-late-badge');
            if (existingBadge) existingBadge.remove();
            if (info.late) {
                const badge = el('span', { className: 'jev-late-badge', text: 'LATE' });
                name.appendChild(badge);
            }
        }

        setComparison(physicsBest, agreePct) {
            this.physicsBestEl.textContent = 'physics would pick: ' + (PLAN_LABELS[physicsBest] || physicsBest || '—');
            this.agreeEl.textContent = 'agreement: ' + (Number.isFinite(agreePct) ? agreePct.toFixed(1) + '%' : '—');
        }

        setUsage(u) {
            this.usageRequestsEl.textContent = String(u.requests);
            this.usageOnTimeEl.textContent = Number.isFinite(u.onTimePct) ? u.onTimePct.toFixed(1) + '%' : '—';
            this.usageTokensEl.textContent = u.tokensIn + ' / ' + u.tokensOut;
            this.usageCostEl.textContent = '$' + u.cost.toFixed(6);
            this.usageRateEl.textContent = Number.isFinite(u.reqPerSec) ? u.reqPerSec.toFixed(2) : '—';
        }

        setLastExchange(request, response) {
            try { this.requestPre.textContent = JSON.stringify(request, null, 2); } catch (e) { this.requestPre.textContent = String(request); }
            try { this.responsePre.textContent = JSON.stringify(response, null, 2); } catch (e) { this.responsePre.textContent = String(response); }
        }

        setHistory(entries) {
            this.historyList.innerHTML = '';
            entries.slice(-10).reverse().forEach(entry => {
                const li = el('li', {
                    text: '#' + entry.index + ' ' + (PLAN_LABELS[entry.plan] || entry.plan) +
                        ' p=' + (Number.isFinite(entry.probability) ? entry.probability.toFixed(2) : '?') +
                        ' lat=' + (Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : '?') + 'ms' +
                        (entry.late ? ' LATE' : '')
                });
                this.historyList.appendChild(li);
            });
        }

        // Positions the panel relative to the canvas. `rect` = {left, top, width, height}
        // in document coordinates. `wide` toggles the side-by-side vs stacked layout.
        layout(rect, wide) {
            document.body.classList.toggle('jev-watch-wide', wide);
            document.body.classList.toggle('jev-watch-narrow', !wide);
            if (wide) {
                this.root.style.top = '';
                this.root.style.left = '';
            } else {
                this.root.style.top = (rect.top + rect.height + 16) + 'px';
            }
        }

        destroy() {
            document.body.classList.remove('jev-watch-open', 'jev-watch-wide', 'jev-watch-narrow');
            if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
        }
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = JevPanel;
    else root.JevPanel = JevPanel;
})(typeof window !== 'undefined' ? window : globalThis);
