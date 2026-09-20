// The Jev panel: a flowchart of one decision, laid over the bottom of the game canvas.
//
// What went into the model, one pass, what came out: five tiles, Jev, two answers,
// wired together for real (the wires are an svg drawn from the tiles' measured
// positions, so they meet the boxes). Under it a small chart of how sure Jev was
// through the flight, and a row of tags for the numbers that are true but not
// the point: answer time, decisions a second, tokens, cost, the lead.
//
// Plain DOM so the text is crisp. Built once on mount, written to only when a value
// changed. Nothing in here animates on its own.

//#region looks
//inset from the canvas edges on every side
const JEV_PANEL_MARGIN = 16;

//a canvas narrower than this stacks the flowchart instead of laying it across
const JEV_PANEL_WIDE = 440;

//a tap on the panel must not also count as a tap on the game
const JEV_PANEL_TAP_MS = 300;

//the five things one request carries, in the order the flowchart stacks them
const JEV_PANEL_INPUTS = ["position", "motion", "room above", "room below", "next pipe"];

//the chart keeps this many applied answers
const JEV_PANEL_CHART_MAX = 240;

//input tokens cost this much per million (output is free)
const JEV_PANEL_COST_PER_M = 0.042;
//#endregion

var JevPanel = (function () {
    var root = null;
    var els = {};

    //folded to the chevron, or the whole thing
    var open = true;

    //the wall clock of the last tap that landed on the panel
    var tapAt = -1e9;

    var onResize = null;

    //the wires are redrawn when a tile moved; this remembers the last geometry key
    var wiresKey = "";
    var frames = 0;

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

    function svgEl(tag) {
        return document.createElementNS("http://www.w3.org/2000/svg", tag);
    }

    //the only way text reaches the panel, so a still frame writes nothing
    function setText(node, value) {
        if (node.textContent !== value) node.textContent = value;
    }

    function setClass(node, cls, on) {
        if (node.classList.contains(cls) === on) return;
        if (on) node.classList.add(cls);
        else node.classList.remove(cls);
    }

    //a tile: a tiny muted name and the live value under it
    function tile(name) {
        let node = el("div", "jp-tile");
        node.appendChild(el("div", "jp-tile-name", name));
        let value = el("div", "jp-tile-value", "–");
        node.appendChild(value);
        return { node: node, value: value };
    }

    //an answer: the word and its probability on one line, filled when it was chosen
    function output(word) {
        let node = el("div", "jp-tile jp-out jp-out-" + word);
        node.appendChild(el("span", "jp-out-name", word));
        let value = el("span", "jp-out-value", "–");
        node.appendChild(value);
        return { node: node, value: value };
    }

    function tag() {
        let node = el("span", "jp-tag");
        let strong = el("b", null, "–");
        let label = el("span", null, "");
        node.appendChild(strong);
        node.appendChild(label);
        return { node: node, strong: strong, label: label };
    }

    function build() {
        root = el("div", "jev-panel");

        els.fold = el("button", "jp-fold");
        els.fold.type = "button";
        els.fold.title = "fold";
        els.fold.appendChild(el("i", null, null));
        els.fold.addEventListener("click", () => {
            open = !open;
            applyOpen();
        });
        root.appendChild(els.fold);

        let body = el("div", "jp-body");
        root.appendChild(body);

        //#region the flowchart
        let flow = el("div", "jp-flow");
        els.flow = flow;

        els.wires = svgEl("svg");
        els.wires.setAttribute("class", "jp-wires");
        flow.appendChild(els.wires);

        let inputs = el("div", "jp-ins");
        els.inputs = [];
        for (let i = 0; i < JEV_PANEL_INPUTS.length; i++) {
            let made = tile(JEV_PANEL_INPUTS[i]);
            inputs.appendChild(made.node);
            els.inputs.push(made);
        }
        flow.appendChild(inputs);

        let jev = el("div", "jp-tile jp-mid");
        jev.appendChild(el("div", "jp-mid-name", "Jev"));
        jev.appendChild(el("div", "jp-tile-name", "one forward pass"));
        els.mid = jev;
        flow.appendChild(jev);

        let outputs = el("div", "jp-outs");
        els.flap = output("flap");
        els.wait = output("wait");
        outputs.appendChild(els.flap.node);
        outputs.appendChild(els.wait.node);
        flow.appendChild(outputs);

        body.appendChild(flow);
        //#endregion

        //#region the chart
        body.appendChild(el("div", "jp-chart-name", "how sure Jev was through the flight"));
        els.chart = el("canvas", "jp-chart");
        body.appendChild(els.chart);
        //#endregion

        //#region the tags
        let tags = el("div", "jp-tags");
        els.tags = {};
        ["answer", "rate", "tokens", "cost", "lead"].forEach(key => {
            els.tags[key] = tag();
            tags.appendChild(els.tags[key].node);
        });
        body.appendChild(tags);
        //#endregion

        //a click anywhere in here is the panel's, not the game's
        root.addEventListener("pointerup", () => {
            tapAt = now();
        }, true);
    }
    //#endregion

    //#region layout
    // An overlay on the canvas and nothing else: it hangs off the bottom of the canvas
    // rect, inset on every side, never taller than the canvas allows. Folded, it is the
    // chevron alone in the bottom right corner, clear of the return button.
    function canvasRect() {
        let node = document.querySelector("canvas");
        if (node == null) return null;
        let rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return rect;
    }

    function applyLayout() {
        if (root == null) return;

        let rect = canvasRect();
        if (rect == null) return;

        root.style.bottom = Math.round(window.innerHeight - rect.bottom + JEV_PANEL_MARGIN) + "px";
        root.style.maxHeight = Math.round(rect.height * 0.6) + "px";

        if (open) {
            root.style.left = Math.round(rect.left + JEV_PANEL_MARGIN) + "px";
            root.style.right = "auto";
            root.style.width = Math.round(rect.width - JEV_PANEL_MARGIN * 2) + "px";
        } else {
            root.style.left = "auto";
            root.style.right = Math.round(window.innerWidth - rect.right + JEV_PANEL_MARGIN) + "px";
            root.style.width = "auto";
        }

        setClass(root, "jp-narrow", rect.width < JEV_PANEL_WIDE);
        wiresKey = "";
    }

    function applyOpen() {
        setClass(root, "jp-open", open);
        applyLayout();
    }
    //#endregion

    //#region the wires
    // Orthogonal connectors, measured from where the tiles really are. Every input
    // leaves its tile, joins a trunk, and the trunk enters Jev; Jev leaves once, a
    // second trunk fans out to the two answers. The chosen answer's wire is drawn in
    // its colour and thicker, the other stays a hairline.
    function centreOf(node, base, side) {
        let r = node.getBoundingClientRect();
        let x = side === "right" ? r.right : side === "left" ? r.left : r.left + r.width / 2;
        let y = side === "top" ? r.top : side === "bottom" ? r.bottom : r.top + r.height / 2;
        return { x: x - base.left, y: y - base.top };
    }

    function path(d, stroke, width) {
        let node = svgEl("path");
        node.setAttribute("d", d);
        node.setAttribute("fill", "none");
        node.setAttribute("stroke", stroke);
        node.setAttribute("stroke-width", width);
        node.setAttribute("stroke-linecap", "round");
        return node;
    }

    //a small chevron at the end of a wire, pointing along dx,dy
    function head(x, y, dx, dy, stroke) {
        let s = 4;
        let d;
        if (dx !== 0) d = "M" + (x - s * dx) + " " + (y - s) + " L" + x + " " + y + " L" + (x - s * dx) + " " + (y + s);
        else d = "M" + (x - s) + " " + (y - s * dy) + " L" + x + " " + y + " L" + (x + s) + " " + (y - s * dy);
        return path(d, stroke, 1);
    }

    function drawWires(chosen) {
        let svg = els.wires;
        let base = els.flow.getBoundingClientRect();
        if (base.width === 0) return;

        let narrow = root.classList.contains("jp-narrow");
        let key = Math.round(base.width) + ":" + Math.round(base.height) + ":" + narrow + ":" + chosen;
        if (key === wiresKey) return;
        wiresKey = key;

        while (svg.firstChild) svg.removeChild(svg.firstChild);
        svg.setAttribute("viewBox", "0 0 " + base.width + " " + base.height);

        let hair = "rgba(230, 233, 242, 0.28)";
        let flapInk = getComputedStyle(root).getPropertyValue("--flap").trim() || "#e43f5a";
        let waitInk = getComputedStyle(root).getPropertyValue("--wait").trim() || "#4f8a8b";

        if (!narrow) {
            //inputs -> trunk -> Jev
            let mid = centreOf(els.mid, base, "left");
            let trunkX = mid.x - 28;
            let ys = els.inputs.map(made => centreOf(made.node, base, "right"));
            ys.forEach(pt => {
                svg.appendChild(path("M" + pt.x + " " + pt.y + " H" + trunkX, hair, 1));
            });
            let top = Math.min(ys[0].y, mid.y);
            let bottom = Math.max(ys[ys.length - 1].y, mid.y);
            svg.appendChild(path("M" + trunkX + " " + top + " V" + bottom, hair, 1));
            svg.appendChild(path("M" + trunkX + " " + mid.y + " H" + mid.x, hair, 1));
            svg.appendChild(head(mid.x, mid.y, 1, 0, hair));

            //Jev -> trunk -> the two answers
            let out = centreOf(els.mid, base, "right");
            let trunk2 = out.x + 24;
            let ends = [els.flap, els.wait].map(made => centreOf(made.node, base, "left"));
            svg.appendChild(path("M" + out.x + " " + out.y + " H" + trunk2, hair, 1));
            svg.appendChild(path("M" + trunk2 + " " + Math.min(ends[0].y, out.y) + " V" + Math.max(ends[1].y, out.y), hair, 1));
            [JevQuestions.FLAP, JevQuestions.WAIT].forEach((word, i) => {
                let picked = chosen === word;
                let ink = picked ? (word === JevQuestions.FLAP ? flapInk : waitInk) : hair;
                svg.appendChild(path("M" + trunk2 + " " + ends[i].y + " H" + ends[i].x, ink, picked ? 2 : 1));
                svg.appendChild(head(ends[i].x, ends[i].y, 1, 0, ink));
            });
        } else {
            //stacked: inputs down to a bus, bus into Jev; Jev down to a bus, bus into each answer
            let mid = centreOf(els.mid, base, "top");
            let busY = mid.y - 13;
            let downs = els.inputs.map(made => centreOf(made.node, base, "bottom"));
            downs.forEach(pt => {
                svg.appendChild(path("M" + pt.x + " " + pt.y + " V" + busY, hair, 1));
            });
            let xs = downs.map(pt => pt.x);
            svg.appendChild(path("M" + Math.min.apply(null, xs.concat(mid.x)) + " " + busY + " H" + Math.max.apply(null, xs.concat(mid.x)), hair, 1));
            svg.appendChild(path("M" + mid.x + " " + busY + " V" + mid.y, hair, 1));
            svg.appendChild(head(mid.x, mid.y, 0, 1, hair));

            let out = centreOf(els.mid, base, "bottom");
            let bus2 = out.y + 13;
            let tops = [els.flap, els.wait].map(made => centreOf(made.node, base, "top"));
            svg.appendChild(path("M" + out.x + " " + out.y + " V" + bus2, hair, 1));
            svg.appendChild(path("M" + tops[0].x + " " + bus2 + " H" + tops[1].x, hair, 1));
            [JevQuestions.FLAP, JevQuestions.WAIT].forEach((word, i) => {
                let picked = chosen === word;
                let ink = picked ? (word === JevQuestions.FLAP ? flapInk : waitInk) : hair;
                svg.appendChild(path("M" + tops[i].x + " " + bus2 + " V" + tops[i].y, ink, picked ? 2 : 1));
                svg.appendChild(head(tops[i].x, tops[i].y, 0, 1, ink));
            });
        }
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

    function gatherChart(scene) {
        if (scene.runId !== chartRun) {
            chartRun = scene.runId;
            chartConf.length = 0;
            chartFlap.length = 0;
            chartSeen = 0;
        }
        let records = scene.trace;
        if (records == null) return;
        let total = scene.traceCount != null ? scene.traceCount : records.length;
        //the trace keeps the last JEV_TRACE_MAX records; walk only the ones we have not seen
        let start = Math.max(0, records.length - (total - chartSeen));
        for (let i = start; i < records.length; i++) {
            let r = records[i];
            if (r.t === "apply" && typeof r.confidence === "number") {
                chartConf.push(r.confidence);
                chartFlap.push(r.choice === JevQuestions.FLAP);
                if (chartConf.length > JEV_PANEL_CHART_MAX) {
                    chartConf.shift();
                    chartFlap.shift();
                }
            }
        }
        chartSeen = total;
    }

    function drawChart(scene) {
        let canvas = els.chart;
        let cssW = canvas.clientWidth;
        let cssH = canvas.clientHeight;
        if (cssW === 0 || cssH === 0) return;

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

        let pad = 6;
        let n = chartConf.length;

        //the half line, so 0.5 has a place on the chart
        ctx.strokeStyle = "rgba(230, 233, 242, 0.12)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad, cssH / 2);
        ctx.lineTo(cssW - pad, cssH / 2);
        ctx.stroke();

        if (n < 2) return;

        let flapInk = getComputedStyle(root).getPropertyValue("--flap").trim() || "#e43f5a";
        let waitInk = getComputedStyle(root).getPropertyValue("--wait").trim() || "#4f8a8b";
        let stepX = (cssW - pad * 2) / (JEV_PANEL_CHART_MAX - 1);
        let x0 = cssW - pad - stepX * (n - 1);
        let yOf = c => pad + (1 - c) * (cssH - pad * 2);

        ctx.strokeStyle = waitInk;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            let x = x0 + stepX * i;
            let y = yOf(chartConf[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.fillStyle = flapInk;
        for (let i = 0; i < n; i++) {
            if (!chartFlap[i]) continue;
            ctx.beginPath();
            ctx.arc(x0 + stepX * i, yOf(chartConf[i]), 2.5, 0, Math.PI * 2);
            ctx.fill();
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

    function inputValue(fields, i) {
        if (fields == null) return "–";
        if (i === 0) return fields.position;
        if (i === 1) return fields.motion;
        if (i === 2) return fields.above + " px";
        if (i === 3) return fields.below + " px";
        return fields.distance + " px";
    }

    function writeOutput(parts, applied, option) {
        let value = probabilityOf(applied, option);
        setText(parts.value, typeof value === "number" ? value.toFixed(2) : "–");
        setClass(parts.node, "jp-chosen", applied != null && applied.choice === option);
    }

    function writeTag(key, strong, label) {
        setText(els.tags[key].strong, strong);
        setText(els.tags[key].label, label);
    }

    function writeTags(scene) {
        let stats = scene.client != null ? scene.client.stats : null;
        let frameMs = scene.frameMs || JEV_FRAME_MS;
        let seconds = Math.max(1, scene.frame * frameMs / 1000);

        writeTag("answer", stats != null && stats.lastLatencyMs ? (stats.lastLatencyMs / 1000).toFixed(2) + " s" : "–", " to answer");
        writeTag("rate", stats != null ? (stats.applied / seconds).toFixed(1) : "–", " decisions a second");

        let tokensPerMinute = stats != null ? Math.round(stats.inputTokens / seconds * 60) : null;
        writeTag("tokens", tokensPerMinute != null ? tokensPerMinute.toLocaleString() : "–", " tokens a minute");
        writeTag("cost", tokensPerMinute != null ? "$" + (tokensPerMinute * 60 * JEV_PANEL_COST_PER_M / 1e6).toFixed(2) : "–", " an hour");

        let lead = scene.lastSent != null ? scene.lastSent.leadFrames * frameMs / 1000 : null;
        writeTag("lead", lead != null ? lead.toFixed(2) + " s" : "–", " ahead");
    }

    function writeValues(scene) {
        let fields = scene.lastSent != null ? scene.lastSent.fields : null;
        for (let i = 0; i < els.inputs.length; i++) {
            setText(els.inputs[i].value, String(inputValue(fields, i)));
        }

        let applied = scene.lastApplied;
        writeOutput(els.flap, applied, JevQuestions.FLAP);
        writeOutput(els.wait, applied, JevQuestions.WAIT);
        drawWires(applied != null ? applied.choice : null);

        gatherChart(scene);
        drawChart(scene);

        //the tags move slowly; every 12th frame is plenty
        if (frames % 12 === 0) writeTags(scene);
    }
    //#endregion

    //#region the scene's calls
    function mount(scene) {
        if (root != null) return;
        open = true;

        build();
        document.body.appendChild(root);

        onResize = () => applyLayout();
        window.addEventListener("resize", onResize);

        applyOpen();
    }

    function unmount() {
        if (root == null) return;
        window.removeEventListener("resize", onResize);
        onResize = null;
        root.remove();
        root = null;
        els = {};
        chartRun = -1;
    }

    //once per draw; writes nothing unless something changed
    function update(scene) {
        if (root == null) return;
        frames++;
        if (!open) return;
        writeValues(scene);
    }

    //a tap that landed on the panel is not a tap on the game
    function tookTap() {
        return now() - tapAt < JEV_PANEL_TAP_MS;
    }

    function isOpen() {
        return root != null && open;
    }
    //#endregion

    return {
        mount: mount,
        unmount: unmount,
        update: update,
        tookTap: tookTap,
        isOpen: isOpen
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevPanel = JevPanel;
