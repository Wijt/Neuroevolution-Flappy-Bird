// The Jev panel: plain DOM beside the canvas. Everything that is telemetry lives
// here now, so the canvas overlay only has to draw what Jev was told.
//
// The whole tree is built once on mount and then only written to when a value
// actually changed, so a frame of updating costs a handful of string compares.
// The chart is the one thing that paints every frame, and it rebuilds from the
// scene's trace tail into arrays that are reused, never reallocated.
//
// On a wide window the panel is fixed beside the canvas; under 1000 px it docks
// on the bottom of the canvas as a sheet collapsed to its header, which is the
// same 1000 px the canvas itself is sized on.

//#region tokens
//the same values the stylesheet keeps, because the chart paints on a canvas
const JEV_PANEL_SURFACE = "#1e2340";
const JEV_PANEL_MUTED = "#8a93b2";
const JEV_PANEL_WAIT = "#4f8a8b";
const JEV_PANEL_DROPPED = "#ffcb74";
const JEV_PANEL_BORDER = "rgba(230,233,242,0.12)";

//the window width the canvas itself switches on, so the panel switches with it
const JEV_PANEL_WIDE = 1000;

//the width the stylesheet gives the panel beside the canvas
const JEV_PANEL_WIDTH = 340;

//the collapsed sheet is exactly its header
const JEV_PANEL_HEADER_H = 44;

//the chart: the plot, a gap, then the tick strip, in CSS px
const JEV_PANEL_PLOT_H = 120;
const JEV_PANEL_STRIP_H = 10;
const JEV_PANEL_STRIP_GAP = 4;

//what an input token costs, in dollars per million
const JEV_PANEL_INPUT_COST = 0.042;

//a rate needs two samples this far apart before it means anything
const JEV_PANEL_SAMPLE_MS = 4000;

//and it starts over once the window is this old, so a spike does not stick
const JEV_PANEL_SAMPLE_MAX_MS = 30000;

//a tap on the panel must not also count as a tap on the game
const JEV_PANEL_TAP_MS = 300;

//the speeds the buttons offer, slowest first
const JEV_PANEL_SPEEDS = [8, 4, 2, 1];
const JEV_PANEL_SPEED_LABELS = ["1/8x", "1/4x", "1/2x", "1x"];
//#endregion

var JevPanel = (function () {
    var root = null;
    var scene = null;
    var els = {};
    var speedButtons = [];

    //the wall clock of the last tap that landed on the panel
    var tapAt = -1e9;

    //true while the window is wide enough for the panel to sit beside the canvas
    var wide = false;

    //the sheet remembers whether the user opened it
    var sheetOpen = false;

    var onResize = null;

    function now() {
        return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }

    function clamp(n, lo, hi) {
        return n < lo ? lo : (n > hi ? hi : n);
    }

    //#region building
    function el(tag, cls, text) {
        let node = document.createElement(tag);
        if (cls != null) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    //the only way text ever reaches the panel, so a still frame writes nothing
    function setText(node, value) {
        if (node.textContent !== value) node.textContent = value;
    }

    function setClass(node, cls, on) {
        if (node.classList.contains(cls) === on) return;
        if (on) node.classList.add(cls);
        else node.classList.remove(cls);
    }

    //one input box of the explainer: a title and a quiet subtitle, nothing else
    function box(title, subtitle, extra) {
        let node = el("div", extra != null ? "jp-box " + extra : "jp-box");
        node.appendChild(el("div", "jp-box-title", title));
        node.appendChild(el("div", "jp-box-sub", subtitle));
        return node;
    }

    //a hairline with a chevron on the end; it points right and it never moves
    function arrow() {
        let node = el("div", "jp-arrow");
        node.appendChild(el("i", null, null));
        return node;
    }

    //one probability bar: the word and the number on top, the track underneath
    function bar(option) {
        let row = el("div", "jp-bar jp-bar-" + option);
        let top = el("div", "jp-bar-top");
        let label = el("span", "jp-bar-name", option);
        let value = el("span", "jp-bar-value", "0.00");
        top.appendChild(label);
        top.appendChild(value);

        let track = el("div", "jp-bar-track");
        let fill = el("span", null, null);
        track.appendChild(fill);

        row.appendChild(top);
        row.appendChild(track);

        return { row: row, label: label, value: value, fill: fill };
    }

    function pill(text, onClick) {
        let node = el("button", "jp-pill", text);
        node.type = "button";
        node.addEventListener("click", onClick);
        return node;
    }

    function build() {
        root = el("div", "jev-panel");

        //#region header
        let head = el("div", "jp-head");
        els.title = el("span", "jp-title", "Flappy Jev");
        els.decision = el("span", "jp-head-decision", "");
        els.score = el("span", "jp-score", "score 0");
        head.appendChild(els.title);
        head.appendChild(els.decision);
        head.appendChild(els.score);
        head.addEventListener("click", () => {
            if (wide) return;
            sheetOpen = !sheetOpen;
            applyLayout();
        });
        root.appendChild(head);
        //#endregion

        let body = el("div", "jp-body");
        root.appendChild(body);

        //#region the explainer
        // Static on purpose: it says what the loop is, and a thing that says what
        // something is has no business moving. Only the bars on its right are live.
        let diagram = el("div", "jp-diagram");

        let inputs = el("div", "jp-dcol");
        inputs.appendChild(box("text snapshot", "the only input"));
        inputs.appendChild(box("option list", "flap · wait"));
        diagram.appendChild(inputs);

        diagram.appendChild(arrow());
        diagram.appendChild(box("one forward pass", "Jev 1.13", "jp-pass"));
        diagram.appendChild(arrow());

        let bars = el("div", "jp-dcol jp-bars");
        bars.appendChild(el("div", "jp-cap", "a probability for every option"));
        els.flap = bar("flap");
        els.wait = bar("wait");
        bars.appendChild(els.flap.row);
        bars.appendChild(els.wait.row);
        diagram.appendChild(bars);

        body.appendChild(diagram);
        //#endregion

        //#region controls
        let controls = el("div", "jp-row");
        els.pause = pill("pause", () => {
            if (scene == null) return;
            scene.togglePause();
        });
        controls.appendChild(els.pause);
        controls.appendChild(pill("restart", () => {
            if (scene == null) return;
            scene.start();
        }));
        controls.appendChild(el("span", "jp-chip", "Jev 1.13"));
        body.appendChild(controls);

        let speed = el("div", "jp-row jp-speed");
        speed.appendChild(el("span", "jp-label", "speed"));
        speedButtons.length = 0;
        for (let i = 0; i < JEV_PANEL_SPEEDS.length; i++) {
            let value = JEV_PANEL_SPEEDS[i];
            let button = pill(JEV_PANEL_SPEED_LABELS[i], () => jevSetTimeScale(value));
            speed.appendChild(button);
            speedButtons.push(button);
        }
        body.appendChild(speed);
        //#endregion

        els.confidence = el("div", "jp-confidence", "confidence –");
        body.appendChild(els.confidence);

        body.appendChild(el("div", "jp-label", "confidence through the flight"));
        els.chart = el("canvas", "jp-chart");
        body.appendChild(els.chart);

        let foot = el("div", "jp-foot");
        els.footRate = el("div", null, "");
        els.footCost = el("div", null, "");
        els.footLead = el("div", null, "");
        foot.appendChild(els.footRate);
        foot.appendChild(els.footCost);
        foot.appendChild(els.footLead);
        body.appendChild(foot);

        //a click anywhere in here is the panel's, not the game's
        root.addEventListener("pointerup", () => {
            tapAt = now();
        }, true);
    }
    //#endregion

    //#region layout
    // Wide: fixed beside the canvas, measured off the canvas rect so it follows
    // the 16:9 letterbox. Narrow: a sheet on the bottom of the window, collapsed
    // to its header until it is tapped.
    function applyLayout() {
        if (root == null) return;

        wide = window.innerWidth >= JEV_PANEL_WIDE;

        setClass(root, "jp-wide", wide);
        setClass(root, "jp-sheet", !wide);
        setClass(root, "jp-open", wide || sheetOpen);

        if (wide) {
            let rect = canvasRect();

            //beside the canvas, but never past the edge of the window: at the very
            //narrowest desktop the letterbox has less than 340 px of room to spare
            let left = rect != null ? Math.min(rect.right + 24, window.innerWidth - JEV_PANEL_WIDTH - 16) : 0;

            root.style.left = rect != null ? Math.round(Math.max(16, left)) + "px" : "";
            root.style.top = rect != null ? Math.round(rect.top) + "px" : "";
            root.style.maxHeight = rect != null ? Math.round(rect.height) + "px" : "";
        } else {
            root.style.left = "";
            root.style.top = "";
            root.style.maxHeight = "";
        }

        sizeChart();
    }

    function canvasRect() {
        let node = document.querySelector("canvas");
        if (node == null) return null;
        let rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return rect;
    }

    //#region the chart surface
    var ctx = null;
    var chartW = 0;
    var chartH = JEV_PANEL_PLOT_H + JEV_PANEL_STRIP_GAP + JEV_PANEL_STRIP_H;

    function sizeChart() {
        if (els.chart == null) return;

        let css = els.chart.clientWidth;
        if (css <= 0) return;

        let ratio = window.devicePixelRatio || 1;
        let w = Math.round(css * ratio);
        let h = Math.round(chartH * ratio);

        if (els.chart.width !== w || els.chart.height !== h) {
            els.chart.width = w;
            els.chart.height = h;
            ctx = null;
        }

        chartW = css;

        if (ctx == null) {
            ctx = els.chart.getContext("2d");
            if (ctx != null) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        }
    }
    //#endregion
    //#endregion

    //#region the trace tail
    // One pass over this flight's records into arrays that are reused. The trace is
    // appended in order and a restart writes a header, so the flight starts at the
    // last header (or at the top, once the oldest lines have fallen off).
    var atFrame = [];
    var confidence = [];
    var wasFlap = [];
    var flapAt = [];
    var droppedAt = [];

    function readTail(s) {
        let trace = s.trace;

        let start = trace.length;
        while (start > 0 && trace[start - 1].t !== "header") start--;

        atFrame.length = 0;
        confidence.length = 0;
        wasFlap.length = 0;
        flapAt.length = 0;
        droppedAt.length = 0;

        for (let i = start; i < trace.length; i++) {
            let record = trace[i];

            if (record.t === "apply") {
                atFrame.push(record.frame);
                confidence.push(typeof record.confidence === "number" ? record.confidence : 0);
                wasFlap.push(record.choice === JevQuestions.FLAP ? 1 : 0);
                continue;
            }

            if (record.t === "flap") {
                flapAt.push(record.frame);
                continue;
            }

            if (record.t === "stale" || record.t === "superseded") droppedAt.push(record.frame);
        }
    }
    //#endregion

    //#region the chart
    function drawChart(s) {
        if (ctx == null) {
            sizeChart();
            if (ctx == null) return;
        }

        let w = chartW;
        let plot = JEV_PANEL_PLOT_H;
        let stripY = plot + JEV_PANEL_STRIP_GAP;
        let pad = 6;

        ctx.clearRect(0, 0, w, chartH);

        ctx.fillStyle = JEV_PANEL_SURFACE;
        ctx.fillRect(0, 0, w, plot);
        ctx.fillRect(0, stripY, w, JEV_PANEL_STRIP_H);

        //a single hairline at a half, so the height of the line means something
        ctx.strokeStyle = JEV_PANEL_BORDER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(plot / 2) + 0.5);
        ctx.lineTo(w, Math.round(plot / 2) + 0.5);
        ctx.stroke();

        let span = Math.max(1, s.frame);
        let inner = Math.max(1, w - pad * 2);

        function x(frame) {
            return pad + clamp(frame / span, 0, 1) * inner;
        }

        function y(value) {
            return pad + (1 - clamp(value, 0, 1)) * (plot - pad * 2);
        }

        if (atFrame.length > 1) {
            ctx.strokeStyle = JEV_PANEL_WAIT;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < atFrame.length; i++) {
                let px = x(atFrame[i]);
                let py = y(confidence[i]);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }

        //the flaps are the only answers that reached the game, so only they get a dot
        ctx.fillStyle = BIRD_COLOR;
        for (let i = 0; i < atFrame.length; i++) {
            if (wasFlap[i] !== 1) continue;
            ctx.beginPath();
            ctx.arc(x(atFrame[i]), y(confidence[i]), 2, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.fillStyle = JEV_PANEL_DROPPED;
        ctx.globalAlpha = 0.45;
        for (let i = 0; i < droppedAt.length; i++) {
            ctx.fillRect(Math.round(x(droppedAt[i])), stripY + 3, 1, JEV_PANEL_STRIP_H - 6);
        }
        ctx.globalAlpha = 1;

        ctx.fillStyle = BIRD_COLOR;
        for (let i = 0; i < flapAt.length; i++) {
            ctx.fillRect(Math.round(x(flapAt[i])), stripY, 1, JEV_PANEL_STRIP_H);
        }
    }
    //#endregion

    //#region rates
    // Two samples of a counter, far enough apart to mean something. A counter that
    // went backwards is a brand new client, so the window starts again.
    var tokenSample = null;
    var tokensPerMinute = null;
    var costPerHour = null;

    var decisionSample = null;
    var decisionsPerSecond = null;

    function updateRates(s) {
        let at = now();
        let stats = s.client.stats;

        if (tokenSample == null || stats.inputTokens < tokenSample.value) {
            tokenSample = { at: at, value: stats.inputTokens };
            tokensPerMinute = null;
            costPerHour = null;
        } else {
            let seconds = (at - tokenSample.at) / 1000;
            if (seconds >= JEV_PANEL_SAMPLE_MS / 1000) {
                let grew = stats.inputTokens - tokenSample.value;
                tokensPerMinute = grew / seconds * 60;
                costPerHour = grew / seconds * 3600 * JEV_PANEL_INPUT_COST / 1e6;
                if (seconds > JEV_PANEL_SAMPLE_MAX_MS / 1000) tokenSample = { at: at, value: stats.inputTokens };
            }
        }

        if (decisionSample == null || stats.applied < decisionSample.value) {
            decisionSample = { at: at, value: stats.applied };
            decisionsPerSecond = null;
        } else {
            let seconds = (at - decisionSample.at) / 1000;
            if (seconds >= JEV_PANEL_SAMPLE_MS / 1000) {
                decisionsPerSecond = (stats.applied - decisionSample.value) / seconds;
                if (seconds > JEV_PANEL_SAMPLE_MAX_MS / 1000) decisionSample = { at: at, value: stats.applied };
            }
        }
    }

    function count(n) {
        return Math.round(n).toLocaleString("en-US");
    }
    //#endregion

    //#region writing the values
    //the probability the answer gave an option, with the binary fallback
    function probabilityOf(answer, option) {
        if (answer == null) return null;
        if (answer.probabilities != null && typeof answer.probabilities[option] === "number") {
            return answer.probabilities[option];
        }
        if (typeof answer.confidence !== "number") return null;
        return answer.choice === option ? answer.confidence : 1 - answer.confidence;
    }

    function writeBar(parts, answer, option) {
        let value = probabilityOf(answer, option);
        let chosen = answer != null && answer.choice === option;

        setText(parts.value, typeof value === "number" ? value.toFixed(2) : "–");
        setClass(parts.row, "jp-on", chosen);
        parts.fill.style.width = (chosen && typeof value === "number" ? clamp(value, 0, 1) * 100 : 0) + "%";
    }

    function writeValues(s) {
        let applied = s.lastApplied;
        let stats = s.client.stats;

        setText(els.score, "score " + (s.bird != null ? s.bird.score : 0));

        writeBar(els.flap, applied, JevQuestions.FLAP);
        writeBar(els.wait, applied, JevQuestions.WAIT);

        let chosen = applied != null ? probabilityOf(applied, applied.choice) : null;
        setText(els.confidence, "confidence " + (typeof chosen === "number" ? chosen.toFixed(2) : "–"));

        //the collapsed sheet shows the decision, it is the only line it has room for
        let word = applied != null && applied.choice != null ? applied.choice.toLowerCase() : "waiting";
        setText(els.decision, word);

        setText(els.pause, s.paused ? "resume" : "pause");

        for (let i = 0; i < speedButtons.length; i++) {
            setClass(speedButtons[i], "jp-on", JEV_PANEL_SPEEDS[i] === JEV_TIME_SCALE);
        }

        let latency = stats.lastLatencyMs > 0 ? stats.lastLatencyMs : s.leadMs;
        setText(els.footRate,
            "decision " + count(stats.applied) +
            " · " + (decisionsPerSecond != null ? decisionsPerSecond.toFixed(1) : "–") + " a second" +
            " · answers in " + (latency / 1000).toFixed(2) + " s");

        setText(els.footCost,
            (tokensPerMinute != null ? count(tokensPerMinute) : "–") + " tokens a minute" +
            " · " + (costPerHour != null ? "$" + costPerHour.toFixed(2) : "$–") + " an hour");

        setText(els.footLead, "asked about the bird " + (s.leadMs / 1000).toFixed(2) + " s ahead");
    }
    //#endregion

    //#region the scene's three calls
    function mount(s) {
        if (root != null) {
            scene = s;
            return;
        }

        scene = s;
        sheetOpen = false;

        build();
        document.body.appendChild(root);

        onResize = () => applyLayout();
        window.addEventListener("resize", onResize);

        applyLayout();
    }

    function unmount() {
        if (root == null) return;

        window.removeEventListener("resize", onResize);
        onResize = null;

        root.remove();
        root = null;
        ctx = null;
        scene = null;
        els = {};
        speedButtons.length = 0;

        tokenSample = null;
        decisionSample = null;
        tokensPerMinute = null;
        costPerHour = null;
        decisionsPerSecond = null;
    }

    //once per draw; a collapsed sheet is not worth a chart
    function update(s) {
        if (root == null) return;

        scene = s;

        if (wide !== (window.innerWidth >= JEV_PANEL_WIDE)) applyLayout();

        updateRates(s);
        writeValues(s);

        if (!wide && !sheetOpen) return;

        if (chartW !== els.chart.clientWidth) sizeChart();

        readTail(s);
        drawChart(s);
    }

    //a tap that landed on the panel is not a tap on the game
    function tookTap() {
        return now() - tapAt < JEV_PANEL_TAP_MS;
    }
    //#endregion

    return {
        mount: mount,
        unmount: unmount,
        update: update,
        tookTap: tookTap
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevPanel = JevPanel;
