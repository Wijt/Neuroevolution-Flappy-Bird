// The Jev dashboard: the whole page around the game, terminal style.
//
// Nothing is ever drawn over the game view any more. The dashboard owns the
// layout: it measures a box for the flight, moves the p5 canvas into it and
// puts everything else beside it. On the left the flight and its three big
// numbers, on the right what Jev was told, what it answered and what that cost.
//
// Plain DOM, built once on mount, written to only when a value changed. Nothing
// animates on its own: the bars, the chart and the clock are the only movement.

//#region looks
//the header row and the three big stats are fixed height, the flight box gets what is left
const JEV_DASH_HEADER = 56;
const JEV_DASH_STATS = 150;

//the title row, the footer and the paddings around the flight box
const JEV_DASH_CHROME = 96;

//a window narrower than this stacks the two columns
const JEV_DASH_WIDE = 1000;

//a window shorter than this tightens the right column so all of it still fits
const JEV_DASH_SHORT = 820;

//a flight box is never smaller than this, however short the window is
const JEV_DASH_MIN_H = 240;

//a tap on the dashboard must not also count as a tap on the game
const JEV_PANEL_TAP_MS = 300;

//the chart keeps this many applied answers
const JEV_PANEL_CHART_MAX = 120;

//the tick strip under the stats shows this many seconds of decisions
const JEV_DASH_TICK_SECONDS = 5;

//input tokens cost this much per million (output is free)
const JEV_PANEL_COST_PER_M = 0.042;

//the five things one request carries, in the order the snapshot lists them
const JEV_DASH_SEEN = ["position", "motion", "room above", "room below", "next pipe"];

//the telemetry block, in order
const JEV_DASH_TELEMETRY = ["answer time", "tokens this flight", "cost"];
//#endregion

var JevPanel = (function () {
    var root = null;
    var els = {};

    //the wall clock of the last tap that landed on the dashboard
    var tapAt = -1e9;

    var onResize = null;
    var frames = 0;

    //the canvas as sketch.js left it, so the other scenes get it back untouched
    var saved = null;

    //the scene, kept so a window resize can lay the flight out again
    var host = null;

    function now() {
        return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }

    //#region building
    function el(tag, cls, text) {
        let node = document.createElement(tag);
        if (cls != null) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    //the only way text reaches the dashboard, so a still frame writes nothing
    function setText(node, value) {
        if (node.textContent !== value) node.textContent = value;
    }

    function setClass(node, cls, on) {
        if (node.classList.contains(cls) === on) return;
        if (on) node.classList.add(cls);
        else node.classList.remove(cls);
    }

    //a caps label over a value, the shape every row in here is made of
    function row(cls, name) {
        let node = el("div", cls);
        node.appendChild(el("span", "jd-cap", name));
        let value = el("span", "jd-val", "–");
        node.appendChild(value);
        return { node: node, value: value };
    }

    //one of the three big numbers: a small caps label over pixel digits
    function stat(name, tone) {
        let node = el("div", "jd-stat");
        node.appendChild(el("div", "jd-cap", name));
        let value = el("div", "jd-digits jd-" + tone, "000");
        node.appendChild(value);
        return { node: node, value: value };
    }

    //a probability row: the marker, the word, a bar on a dotted track, the number
    function probRow(word) {
        let node = el("div", "jd-prob jd-prob-" + word.toLowerCase());
        node.appendChild(el("span", "jd-mark", "›"));
        node.appendChild(el("span", "jd-name", word));
        let track = el("span", "jd-track");
        let fill = el("i", "jd-fill");
        track.appendChild(fill);
        node.appendChild(track);
        let value = el("span", "jd-val", "–");
        node.appendChild(value);
        return { node: node, fill: fill, value: value };
    }


    function section(name, note) {
        let node = el("div", "jd-section");
        node.appendChild(el("span", "jd-cap", name));
        if (note != null) node.appendChild(el("span", "jd-cap jd-note", note));
        return node;
    }

    function build() {
        root = el("div", "jev-dash");

        //#region the header
        let head = el("div", "jd-head");
        els.back = el("div", "jd-back-slot");
        head.appendChild(els.back);
        head.appendChild(el("div", "jd-cap jd-brand", "Flappy Jev"));
        els.live = el("div", "jd-cap jd-teal", "live");
        head.appendChild(els.live);
        root.appendChild(head);
        //#endregion

        let main = el("div", "jd-main");
        root.appendChild(main);

        //#region the left column: the flight and its numbers
        let left = el("div", "jd-left");
        els.left = left;

        let title = el("div", "jd-title");
        els.flight = el("div", "jd-cap jd-muted", "flight 01");
        title.appendChild(els.flight);
        left.appendChild(title);

        els.box = el("div", "jd-box");
        left.appendChild(els.box);

        let stats = el("div", "jd-stats");
        els.score = stat("score", "teal");
        els.best = stat("best", "white");
        els.decisions = stat("decisions", "grey");
        stats.appendChild(els.score.node);
        stats.appendChild(els.best.node);
        stats.appendChild(els.decisions.node);
        left.appendChild(stats);

        let ticks = el("div", "jd-ticks");
        els.ticks = el("canvas", "jd-tick-canvas");
        ticks.appendChild(els.ticks);
        els.rate = el("span", "jd-val", "–");
        ticks.appendChild(els.rate);
        left.appendChild(ticks);

        main.appendChild(left);
        //#endregion

        //#region the right column: the pilot
        let right = el("div", "jd-right");

        let pilot = el("div", "jd-pilot");
        pilot.appendChild(el("span", "jd-teal", "Jev 1.13"));
        pilot.appendChild(el("span", "jd-cap jd-muted jd-by", "by TypeSafe"));
        right.appendChild(pilot);

        right.appendChild(section("next move", null));
        els.flap = probRow("flap");
        els.wait = probRow("wait");
        right.appendChild(els.flap.node);
        right.appendChild(els.wait.node);

        let executing = el("div", "jd-exec");
        executing.appendChild(el("span", "jd-cap", "executing"));
        els.executing = el("span", "jd-cap jd-teal jd-exec-value", "waiting for the pilot");
        executing.appendChild(els.executing);
        right.appendChild(executing);

        els.aheadValue = el("span", "jd-cap jd-note", "–");
        let seenHead = section("what Jev sees", null);
        seenHead.appendChild(els.aheadValue);
        right.appendChild(seenHead);
        els.seen = [];
        for (let i = 0; i < JEV_DASH_SEEN.length; i++) {
            let made = row("jd-row", JEV_DASH_SEEN[i]);
            right.appendChild(made.node);
            els.seen.push(made);
        }
        right.appendChild(section("how sure it was, this flight", null));
        els.chart = el("canvas", "jd-chart");
        right.appendChild(els.chart);

        let telemetry = el("div", "jd-telemetry");
        els.tel = {};
        for (let i = 0; i < JEV_DASH_TELEMETRY.length; i++) {
            let made = row("jd-row", JEV_DASH_TELEMETRY[i]);
            telemetry.appendChild(made.node);
            els.tel[JEV_DASH_TELEMETRY[i]] = made;
        }
        right.appendChild(telemetry);

        main.appendChild(right);
        //#endregion

        //#region the footer
        let foot = el("div", "jd-foot");
        foot.appendChild(el("div", "jd-cap jd-muted", "space pause · v overlay · r reset · d trace"));
        let end = el("div", "jd-foot-end");
        els.clock = el("span", "jd-cap jd-teal", "00:00");
        end.appendChild(els.clock);
        foot.appendChild(end);
        root.appendChild(foot);
        //#endregion

        //a click anywhere in here is the dashboard's, not the game's
        //a click on the dashboard is the dashboard's, not the game's; the canvas lives
        //inside the dashboard now, so a tap on the flight itself is left to the game
        root.addEventListener("pointerup", event => {
            if (event.target != null && event.target.tagName === "CANVAS") return;
            tapAt = now();
        }, true);
    }
    //#endregion

    //#region layout
    // The dashboard decides how big the flight is, not sketch.js. The box gets the
    // window height minus the header, the three big stats and the chrome around
    // them; the canvas is 9:16 inside it and moves into the box so it scrolls and
    // resizes with the rest of the page.
    function canvasElement() {
        return document.querySelector("canvas");
    }

    //the canvas is resized and reparented here and nowhere else
    function layoutGame() {
        if (root == null) return null;

        let stacked = window.innerWidth < JEV_DASH_WIDE;
        setClass(root, "jd-stacked", stacked);
        //a short window has to give the right column tighter spacing to keep it whole
        setClass(root, "jd-short", window.innerHeight < JEV_DASH_SHORT);

        //measure the column with no inline width on it, then give it the one it needs
        els.left.style.width = "";
        els.box.style.width = "";

        let size;
        if (stacked) {
            //full width, aspect kept, so the flight is still the biggest thing on a phone
            let w = Math.max(160, Math.round(els.left.clientWidth));
            size = { w: w, h: Math.round(w * 16 / 9) };
        } else {
            let h = window.innerHeight - JEV_DASH_HEADER - JEV_DASH_STATS - JEV_DASH_CHROME;
            h = Math.max(JEV_DASH_MIN_H, Math.round(h));
            size = { w: Math.round(h * 9 / 16), h: h };
            //the column clips, so it has to be as wide as the box including its two borders
            els.left.style.width = (size.w + 2) + "px";
        }

        els.box.style.width = size.w + "px";
        els.box.style.height = size.h + "px";

        let node = canvasElement();
        if (node != null && (width !== size.w || height !== size.h)) {
            //noRedraw: we are inside the scene's start(), the world is half built
            resizeCanvas(size.w, size.h, true);
        }
        if (node != null && node.parentNode !== els.box) {
            node.style.position = "static";
            node.style.left = "";
            node.style.top = "";
            node.style.display = "block";
            els.box.appendChild(node);
        }

        return size;
    }
    //#endregion

    //#region the chart
    // One line: the probability Jev gave the answer it actually applied, over the
    // flight. A flap is a dot in the bird's red on that line; a wait leaves the line
    // alone. Read from the trace tail, into two reused arrays.
    var chartConf = [];
    var chartFlap = [];
    var chartSeen = 0;
    var chartRun = -1;

    //the decisions of the last few seconds, for the tick strip
    var ticks = [];

    //what the counters stood at when this flight began; the stats are per session
    var flightStartMs = 0;
    //set when the bird dies, so the clock and the rates stop with the flight
    var flightEndMs = null;
    var baseApplied = 0;
    var baseTokens = 0;
    var bestScore = 0;

    function ink(name, fallback) {
        let value = getComputedStyle(root).getPropertyValue(name).trim();
        return value !== "" ? value : fallback;
    }

    function newFlight(scene) {
        chartRun = scene.runId;
        chartConf.length = 0;
        chartFlap.length = 0;
        ticks.length = 0;
        chartSeen = scene.traceCount != null ? scene.traceCount : 0;
        flightStartMs = now();
        flightEndMs = null;
        let stats = scene.client != null ? scene.client.stats : null;
        baseApplied = stats != null ? stats.applied : 0;
        baseTokens = stats != null ? stats.inputTokens : 0;
    }

    function gather(scene) {
        if (scene.runId !== chartRun) newFlight(scene);

        let records = scene.trace;
        if (records == null) return;

        let total = scene.traceCount != null ? scene.traceCount : records.length;
        //the trace keeps the last JEV_TRACE_MAX records; walk only the ones we have not seen
        let start = Math.max(0, records.length - (total - chartSeen));
        let at = now();

        for (let i = start; i < records.length; i++) {
            let r = records[i];

            if (r.t === "apply") {
                ticks.push({ at: at, kind: r.choice === JevQuestions.FLAP ? "flap" : "wait" });
                if (typeof r.confidence === "number") {
                    chartConf.push(r.confidence);
                    chartFlap.push(r.choice === JevQuestions.FLAP);
                    if (chartConf.length > JEV_PANEL_CHART_MAX) {
                        chartConf.shift();
                        chartFlap.shift();
                    }
                }
            } else if (r.t === "stale" || r.t === "superseded") {
                ticks.push({ at: at, kind: "dropped" });
            }
        }
        chartSeen = total;

        let cut = at - JEV_DASH_TICK_SECONDS * 1000;
        while (ticks.length > 0 && ticks[0].at < cut) ticks.shift();
    }

    //a canvas that follows its css size, whatever the display's pixel ratio is
    function fitCanvas(canvas) {
        let cssW = canvas.clientWidth;
        let cssH = canvas.clientHeight;
        if (cssW === 0 || cssH === 0) return null;

        let dpr = window.devicePixelRatio || 1;
        let w = Math.round(cssW * dpr);
        let h = Math.round(cssH * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }

        let ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        return { ctx: ctx, w: cssW, h: cssH };
    }

    function drawChart() {
        let fit = fitCanvas(els.chart);
        if (fit == null) return;

        let ctx = fit.ctx;
        let pad = 6;
        let n = chartConf.length;

        //the half line, so 0.5 has a place on the chart
        ctx.strokeStyle = ink("--line", "#1f2a33");
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad, fit.h / 2);
        ctx.lineTo(fit.w - pad, fit.h / 2);
        ctx.stroke();

        if (n < 2) return;

        //fills from the left; once the chart is full the oldest point falls off
        let stepX = (fit.w - pad * 2) / (JEV_PANEL_CHART_MAX - 1);
        let x0 = pad;
        let yOf = c => pad + (1 - c) * (fit.h - pad * 2);

        ctx.strokeStyle = ink("--teal", "#3ddc97");
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            let x = x0 + stepX * i;
            let y = yOf(chartConf[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.fillStyle = ink("--flap", "#e43f5a");
        for (let i = 0; i < n; i++) {
            if (!chartFlap[i]) continue;
            ctx.beginPath();
            ctx.arc(x0 + stepX * i, yOf(chartConf[i]), 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    //the last few seconds of decisions, one tick each, oldest at the left
    function drawTicks() {
        let fit = fitCanvas(els.ticks);
        if (fit == null) return;

        let ctx = fit.ctx;
        let y = Math.round(fit.h / 2);

        ctx.strokeStyle = ink("--line", "#1f2a33");
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(fit.w, y + 0.5);
        ctx.stroke();

        let span = JEV_DASH_TICK_SECONDS * 1000;
        let at = now();
        let colors = {
            flap: ink("--flap", "#e43f5a"),
            wait: ink("--teal", "#3ddc97"),
            dropped: ink("--line", "#1f2a33")
        };

        for (let i = 0; i < ticks.length; i++) {
            let age = at - ticks[i].at;
            let x = Math.round(fit.w * (1 - age / span));
            if (x < 0 || x > fit.w) continue;
            ctx.strokeStyle = colors[ticks[i].kind];
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, fit.h);
            ctx.stroke();
        }
    }
    //#endregion

    //#region writing the values
    function probabilityOf(answer, option) {
        if (answer == null) return null;
        if (answer.probabilities != null && typeof answer.probabilities[option] === "number") {
            return answer.probabilities[option];
        }
        if (typeof answer.confidence !== "number") return null;
        return answer.choice === option ? answer.confidence : 1 - answer.confidence;
    }

    function clamp01(n) {
        return n < 0 ? 0 : (n > 1 ? 1 : n);
    }

    function pad3(n) {
        let text = String(Math.max(0, Math.round(n)));
        while (text.length < 3) text = "0" + text;
        return text;
    }

    function seenValue(fields, i) {
        if (fields == null) return "–";
        if (i === 0) return fields.position;
        if (i === 1) return fields.motion;
        if (i === 2) return fields.above + " px";
        if (i === 3) return fields.below + " px";
        return fields.distance + " px";
    }

    function writeProb(parts, applied, option) {
        let value = probabilityOf(applied, option);
        setText(parts.value, typeof value === "number" ? value.toFixed(2) : "–");
        parts.fill.style.width = (typeof value === "number" ? clamp01(value) * 100 : 0) + "%";
        setClass(parts.node, "jd-chosen", applied != null && applied.choice === option);
    }


    //decisions a second, off the tick strip, so it is a rate and not an average
    function decisionRate() {
        let applied = 0;
        for (let i = 0; i < ticks.length; i++) {
            if (ticks[i].kind !== "dropped") applied++;
        }
        return applied / JEV_DASH_TICK_SECONDS;
    }

    function writeSlow(scene) {
        let stats = scene.client != null ? scene.client.stats : null;
        //a dead bird stops the clock; the next flight starts it again
        if (scene.bird != null && !scene.bird.live) {
            if (flightEndMs == null) flightEndMs = now();
        } else {
            flightEndMs = null;
        }
        let seconds = Math.max(0.001, ((flightEndMs != null ? flightEndMs : now()) - flightStartMs) / 1000);

        setText(els.flight, "flight " + pad3(scene.runId).slice(1));

        //the three big numbers of this flight
        let score = scene.bird != null ? scene.bird.score : 0;
        if (score > bestScore) bestScore = score;
        setText(els.score.value, pad3(score));
        setText(els.best.value, pad3(bestScore));

        let applied = stats != null ? stats.applied - baseApplied : 0;
        setText(els.decisions.value, pad3(applied));

        setText(els.rate, decisionRate().toFixed(1) + " /s");

        setText(els.tel["answer time"].value, stats != null && stats.lastLatencyMs ? Math.round(stats.lastLatencyMs) + " ms" : "–");

        let tokens = stats != null ? Math.max(0, stats.inputTokens - baseTokens) : 0;
        setText(els.tel["tokens this flight"].value, tokens.toLocaleString());

        let perHour = tokens / seconds * 3600 * JEV_PANEL_COST_PER_M / 1e6;
        setText(els.tel.cost.value, "$" + perHour.toFixed(2) + " an hour");

        setText(els.live, "live · " + (JEV_TIME_SCALE === 1 ? "full speed" : "1/" + JEV_TIME_SCALE + " speed"));

        let elapsed = Math.floor(seconds);
        setText(els.clock, pad3(Math.floor(elapsed / 60)).slice(1) + ":" + pad3(elapsed % 60).slice(1));
    }

    function writeValues(scene) {
        let fields = scene.lastSent != null ? scene.lastSent.fields : null;
        for (let i = 0; i < els.seen.length; i++) {
            setText(els.seen[i].value, String(seenValue(fields, i)));
        }

        let frameMs = scene.frameMs || JEV_FRAME_MS;
        let lead = scene.lastSent != null ? scene.lastSent.leadFrames * frameMs / 1000 : null;
        setText(els.aheadValue, lead != null ? Math.round(lead * 1000) + " ms ahead" : "–");

        let applied = scene.lastApplied;
        writeProb(els.flap, applied, JevQuestions.FLAP);
        writeProb(els.wait, applied, JevQuestions.WAIT);

        let waiting = scene.waitingForPilot || applied == null || applied.choice == null;
        setText(els.executing, waiting ? "waiting for the pilot" : applied.choice.toLowerCase());
        setClass(els.executing, "jd-flap", !waiting && applied.choice === JevQuestions.FLAP);

        gather(scene);
        drawChart();
        drawTicks();

        //the slow numbers move in words, not in frames; every 12th frame is plenty
        if (frames % 12 === 0) writeSlow(scene);
    }
    //#endregion

    //#region the scene's calls
    function mount(scene) {
        if (root != null) return;

        host = scene;

        let node = canvasElement();
        if (node != null) {
            //exactly as sketch.js left it, so play, train and watch get it back
            saved = {
                w: width,
                h: height,
                parent: node.parentNode,
                position: node.style.position,
                left: node.style.left,
                top: node.style.top,
                display: node.style.display
            };
        }

        build();
        document.body.appendChild(root);
        document.body.classList.add("jev-body");

        chartRun = -1;

        onResize = () => {
            let before = width + "x" + height;
            let size = layoutGame();
            //a real change leaves the pipes laid out for the old size, so the flight starts again
            if (size == null || before === size.w + "x" + size.h) return;
            if (host != null && host.gameStarted) host.start();
        };
        window.addEventListener("resize", onResize);

        layoutGame();
    }

    function unmount() {
        if (root == null) return;

        window.removeEventListener("resize", onResize);
        onResize = null;

        let node = canvasElement();
        if (node != null && saved != null) {
            resizeCanvas(saved.w, saved.h, true);
            saved.parent.appendChild(node);
            node.style.position = saved.position;
            node.style.left = saved.left;
            node.style.top = saved.top;
            node.style.display = saved.display;
        }
        saved = null;

        document.body.classList.remove("jev-body");
        root.remove();
        root = null;
        els = {};
        host = null;
        chartRun = -1;
    }

    //once per draw; writes nothing unless something changed
    function update(scene) {
        if (root == null) return;
        frames++;
        writeValues(scene);
    }

    //the way out of the scene lives in the header, never over the flight
    function placeBack(node) {
        if (root == null || node == null) return;
        node.classList.add("jd-back");
        els.back.appendChild(node);
    }

    //a tap that landed on the dashboard is not a tap on the game
    function tookTap() {
        return now() - tapAt < JEV_PANEL_TAP_MS;
    }

    //the canvas is the sensory layer only: the dashboard says everything else
    function isOpen() {
        return root != null;
    }
    //#endregion

    return {
        mount: mount,
        unmount: unmount,
        update: update,
        placeBack: placeBack,
        tookTap: tookTap,
        isOpen: isOpen
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevPanel = JevPanel;
