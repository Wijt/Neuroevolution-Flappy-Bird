// The side panel that shows what Jev is thinking, as a dashboard.
// Plain DOM on purpose: p5 0.10.2's createDiv() is clumsy for something this nested,
// and the panel must never touch the canvas.
//
// It answers four questions in order: is the loop healthy (the badges), what did we
// describe to Jev (the schematic), what came back and what did we spend it on (the
// flow), and how the requests actually overlapped in time (the pipeline). The raw
// trace is still there, folded away, because that is the thing you read when something
// looks wrong.
//
// The scene hands us one view per draw frame and nothing else, so everything the
// dashboard needs that the view does not carry is derived from view.trace here.
const JEV_DECISION_OPTIONS = [
    "FLAP",
    "WAIT"
];

//how many trace lines the panel keeps on screen, the log itself is much longer
const JEV_TRACE_SHOWN = 12;

//the pipeline and the rates look at the last 5 seconds of game frames
const JEV_WINDOW_FRAMES = 300;
const JEV_FPS = 60;

//what an input token costs, in dollars per million
const JEV_INPUT_COST = 0.042;

//canvas heights in css px, the widths follow the panel
const JEV_H_SNAPSHOT = 190;
const JEV_H_FLOW = 120;
const JEV_H_TIMELINE = 70;

//the text badges only need to be readable, not smooth; ~10 Hz is plenty
const JEV_BADGE_EVERY = 6;

//how long the action edge stays lit after an applied FLAP, and the Jev node after a recv
const JEV_PULSE_MS = 320;

//the timeline says "lower half", the snapshot says "inside the gap, lower half"
const JEV_POSITION_SHORT = {
    "above the gap": "above gap",
    "below the gap": "below gap",
    "inside the gap, upper half": "upper half",
    "inside the gap, lower half": "lower half"
};

const JEV_BADGES = [
    { key: "latency", label: "latency" },
    { key: "lead", label: "lead" },
    { key: "rps", label: "req/s" },
    { key: "tpm", label: "tok/min" },
    { key: "cost", label: "$/h" },
    { key: "speed", label: "speed" }
];

const JEV_COUNTERS = [
    { key: "applied", label: "applied" },
    { key: "superseded", label: "superseded" },
    { key: "stale", label: "stale" }
];

//#region trace formatting
// Same shapes the harness prints, so a browser trace and a headless one line up.
function jevFrameTag(frame) {
    let s = String(frame);
    while (s.length < 4) s = "0" + s;
    return "f" + s;
}

//probabilities read better without the leading zero: .61
function jevProb(p) {
    let n = Number(p);
    if (!isFinite(n)) return "n/a";
    let text = n.toFixed(2);
    return text.charAt(0) === "0" ? text.slice(1) : text;
}

function jevShortPosition(position) {
    if (position == null) return "-";
    return JEV_POSITION_SHORT[position] != null ? JEV_POSITION_SHORT[position] : position;
}

// one record -> one timeline line
function jevTraceLines(record) {
    if (record == null) return [];

    if (record.t === "header") {
        return ["-- run " + record.runId + " v" + record.version +
            ", tick " + record.tickMs + "ms, " + record.maxInFlight + " in flight" +
            ", late " + record.lateFrames + "f" +
            ", speed 1/" + record.timeScale +
            ", translator " + record.translator +
            ", freshness " + record.freshness];
    }

    if (record.t === "send") {
        let fields = record.fields || {};
        let actual = record.actual || {};

        return [jevFrameTag(record.frame) + " send #" + record.reqId +
            " ->" + jevFrameTag(record.targetFrame) + " (" + record.leadFrames + "f)" +
            " y=" + Math.round(actual.birdY) +
            " v=" + Number(actual.vel).toFixed(1) +
            " | " + jevShortPosition(fields.position) +
            " | " + (fields.motion != null ? fields.motion : "-") +
            " | dist " + (fields.distance != null ? fields.distance : "-")];
    }

    if (record.t === "recv") {
        return [jevFrameTag(record.frame) + " recv #" + record.reqId +
            " (" + record.latencyMs + "ms) " + (record.choice || "?") +
            " " + jevProb(record.confidence) +
            " " + record.outcome];
    }

    if (record.t === "apply") {
        return [jevFrameTag(record.frame) + " apply #" + record.reqId +
            " " + (record.choice || "?") + " (" + record.lateBy + "f late)"];
    }

    if (record.t === "stale") {
        return [jevFrameTag(record.frame) + " stale #" + record.reqId +
            " (" + record.lateBy + "f late)"];
    }

    if (record.t === "superseded") {
        let asked = record.asked || {};
        let current = record.current || {};

        return [jevFrameTag(record.frame) + " superseded #" + record.reqId +
            " (" + (record.reason || "premise") + ": " +
            jevShortPosition(asked.position) + "/" + (asked.motion || "-") +
            " -> " + jevShortPosition(current.position) + "/" + (current.motion || "-") + ")"];
    }

    if (record.t === "flap") {
        return [jevFrameTag(record.frame) + " flap"];
    }

    if (record.t === "death") {
        return [jevFrameTag(record.frame) + " DEATH " + (record.cause || "?") +
            " score " + record.score];
    }

    return [JSON.stringify(record)];
}
//#endregion

//one clock for the animations, same fallback the scene uses
function jevPanelNow() {
    return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

class JevPanel {
    constructor(getRect, getTraceFile) {
        this.getRect = getRect;
        this.getTraceFile = getTraceFile;
        this.destroyed = false;
        this.cache = {};

        this.badgeNodes = {};
        this.counterNodes = {};

        //#region the model the canvases read, all of it derived from the trace
        //one entry per request, in send order; the pipeline and the packets share it
        this.requests = [];
        this.byId = {};
        this.flaps = [];
        this.deaths = [];

        //the scene's frame counter, followed rather than read: it is not in the view
        this.nowFrame = 0;

        //an EMA of the measured round trip, it is what a packet's position is scaled by
        this.latencyMs = 400;

        this.lastRecv = null;
        this.sparkAt = -1e9;
        this.pulseAt = -1e9;

        //two samples of the token counter are enough for a rate
        this.tokenNow = { frame: 0, tokens: 0 };
        this.tokenThen = null;

        //reused so a frame of animation allocates nothing
        this.packets = [];
        this.bars = { FLAP: null, WAIT: null };
        this.flowModel = { w: 0, h: 0, packets: this.packets, bars: this.bars, choice: null, pulse: 0, spark: 0 };
        this.timelineModel = { w: 0, h: 0, window: JEV_WINDOW_FRAMES, requests: this.requests, flaps: this.flaps, deaths: this.deaths };
        //#endregion

        this.frames = 0;

        this.build();

        this.onResize = () => {
            if (this.destroyed) return;
            this.layout(this.getRect ? this.getRect() : null);
        };
        window.addEventListener("resize", this.onResize);

        this.layout(this.getRect ? this.getRect() : null);
    }

    //#region building
    build() {
        this.root = document.createElement("div");
        this.root.className = "jev-panel";
        this.root.setAttribute("data-status", "live");

        //#region header
        let header = document.createElement("div");
        header.className = "jev-head";

        let title = document.createElement("span");
        title.textContent = "JEV PILOT";
        header.appendChild(title);

        let state = document.createElement("span");
        state.className = "jev-state";

        this.statusLabel = document.createElement("span");
        this.statusLabel.className = "jev-status";
        this.statusLabel.textContent = "waiting";
        state.appendChild(this.statusLabel);

        this.dot = document.createElement("span");
        this.dot.className = "jev-dot";
        state.appendChild(this.dot);

        header.appendChild(state);

        //the whole panel folds away on a narrow screen, the header is the handle
        header.addEventListener("click", () => {
            this.root.classList.toggle("is-open");
        });
        this.root.appendChild(header);
        //#endregion

        //#region badges
        let badges = document.createElement("div");
        badges.className = "jev-badges jev-section";

        JEV_BADGES.forEach(badge => {
            let box = document.createElement("span");
            box.className = "jev-badge";

            let name = document.createElement("span");
            name.className = "jev-badge-name";
            name.textContent = badge.label;

            let value = document.createElement("span");
            value.className = "jev-badge-value";
            value.textContent = "-";

            box.appendChild(name);
            box.appendChild(value);
            badges.appendChild(box);

            this.badgeNodes[badge.key] = value;
        });

        this.root.appendChild(badges);
        //#endregion

        //#region what jev sees
        this.root.appendChild(this.makeTitle("what jev sees"));

        let seen = document.createElement("div");
        this.snapshotCanvas = this.makeCanvas(JEV_H_SNAPSHOT);
        seen.appendChild(this.snapshotCanvas.el);

        this.positionWord = document.createElement("div");
        this.positionWord.className = "jev-word";
        this.positionWord.textContent = "-";
        seen.appendChild(this.positionWord);

        this.motionWord = document.createElement("div");
        this.motionWord.className = "jev-word jev-word-soft";
        this.motionWord.textContent = "-";
        seen.appendChild(this.motionWord);

        this.describedLabel = document.createElement("div");
        this.describedLabel.className = "jev-dim";
        this.describedLabel.textContent = "described at +0f";
        seen.appendChild(this.describedLabel);

        this.root.appendChild(this.wrap(seen));
        //#endregion

        //#region decision flow
        this.root.appendChild(this.makeTitle("decision flow"));

        let flow = document.createElement("div");
        this.flowCanvas = this.makeCanvas(JEV_H_FLOW);
        flow.appendChild(this.flowCanvas.el);

        this.decisionWord = document.createElement("div");
        this.decisionWord.className = "jev-word";
        this.decisionWord.textContent = "-";
        flow.appendChild(this.decisionWord);

        let counters = document.createElement("div");
        counters.className = "jev-counters";

        JEV_COUNTERS.forEach(counter => {
            let box = document.createElement("span");
            box.className = "jev-counter is-" + counter.key;

            let value = document.createElement("span");
            value.className = "jev-counter-value";
            value.textContent = "-";

            let name = document.createElement("span");
            name.className = "jev-counter-name";
            name.textContent = counter.label;

            box.appendChild(value);
            box.appendChild(name);
            counters.appendChild(box);

            this.counterNodes[counter.key] = value;
        });

        flow.appendChild(counters);
        this.root.appendChild(this.wrap(flow));
        //#endregion

        //#region pipeline
        this.root.appendChild(this.makeTitle("pipeline"));

        let pipeline = document.createElement("div");
        this.timelineCanvas = this.makeCanvas(JEV_H_TIMELINE);
        pipeline.appendChild(this.timelineCanvas.el);

        this.inFlightLabel = document.createElement("div");
        this.inFlightLabel.className = "jev-dim";
        this.inFlightLabel.textContent = "in flight -";
        pipeline.appendChild(this.inFlightLabel);

        this.root.appendChild(this.wrap(pipeline));
        //#endregion

        //#region trace, folded away
        let fold = document.createElement("div");
        fold.className = "jev-fold jev-section";
        this.traceFold = fold;

        let foldHead = document.createElement("div");
        foldHead.className = "jev-fold-head";

        let caret = document.createElement("span");
        caret.className = "jev-caret";
        caret.textContent = "▶";
        foldHead.appendChild(caret);

        let foldName = document.createElement("span");
        foldName.textContent = "trace";
        foldHead.appendChild(foldName);

        foldHead.addEventListener("click", () => {
            fold.classList.toggle("is-open");
            //the log is only written while it is on screen, so catch it up now
            this.cache.traceSeq = null;
        });
        fold.appendChild(foldHead);

        let body = document.createElement("div");
        body.className = "jev-fold-body";

        let legend = document.createElement("div");
        legend.className = "jev-legend";
        legend.textContent = "P pause  N step  M next event";
        body.appendChild(legend);

        this.traceLog = document.createElement("div");
        this.traceLog.className = "jev-trace";
        body.appendChild(this.traceLog);

        this.downloadButton = document.createElement("button");
        this.downloadButton.className = "jev-download";
        this.downloadButton.type = "button";
        this.downloadButton.textContent = "download trace";
        this.downloadButton.addEventListener("click", () => this.downloadTrace());
        body.appendChild(this.downloadButton);

        fold.appendChild(body);
        this.root.appendChild(fold);
        //#endregion

        document.body.appendChild(this.root);
    }

    //a canvas that keeps its css height and takes its width from the panel
    makeCanvas(cssHeight) {
        let el = document.createElement("canvas");
        el.className = "jev-canvas";
        el.style.height = cssHeight + "px";

        return { el: el, ctx: el.getContext("2d"), w: 0, h: cssHeight, dpr: 0 };
    }

    makeTitle(text) {
        let node = document.createElement("div");
        node.className = "jev-title jev-section";
        node.textContent = text;
        return node;
    }

    wrap(child) {
        let box = document.createElement("div");
        box.className = "jev-section";
        box.appendChild(child);
        return box;
    }
    //#endregion

    // rect is the canvas' bounding rect; on narrow screens the css docks the panel
    // to the bottom instead, so no inline styles may be left behind.
    layout(rect) {
        if (this.destroyed) return;

        this.root.style.left = "";
        this.root.style.top = "";
        this.root.style.height = "";

        if (window.innerWidth <= 1000) return;
        if (rect == null) return;

        this.root.style.left = (rect.right + 12) + "px";
        this.root.style.top = rect.top + "px";
        this.root.style.height = rect.height + "px";
    }

    //#region writing to the dom, only when something changed
    setText(key, node, value) {
        if (this.cache[key] === value) return;
        this.cache[key] = value;
        node.textContent = value;
    }
    //#endregion

    //#region reading the trace
    // The log only ever grows and its sequence number counts every record ever written,
    // so the difference tells us exactly how many entries at the tail are new. Reading it
    // that way survives the log dropping its oldest lines.
    ingest(trace) {
        if (trace == null) return;

        let entries = trace.entries || [];

        if (this.cache.ingestSeq == null) {
            //first look: take the tail so the pipeline has something to show
            this.cache.ingestSeq = Math.max(0, trace.seq - entries.length);
        }

        let fresh = Math.min(trace.seq - this.cache.ingestSeq, entries.length);
        if (fresh <= 0) return;

        this.cache.ingestSeq = trace.seq;

        for (let i = entries.length - fresh; i < entries.length; i++) {
            this.ingestRecord(entries[i]);
        }
    }

    ingestRecord(record) {
        if (record == null) return;

        if (typeof record.frame === "number" && record.frame > this.nowFrame) {
            this.nowFrame = record.frame;
        }

        //a new run starts the frame counter over, so everything on screen goes with it
        if (record.t === "header") {
            this.resetRun();
            return;
        }

        if (record.t === "send") {
            let request = {
                reqId: record.reqId,
                sendFrame: record.frame,
                recvFrame: null,
                outcome: null,
                sentAt: jevPanelNow()
            };
            this.requests.push(request);
            this.byId[record.reqId] = request;
            this.prune();
            return;
        }

        if (record.t === "recv") {
            this.latencyMs = this.latencyMs + 0.3 * (record.latencyMs - this.latencyMs);
            this.sparkAt = jevPanelNow();
            this.lastRecv = record;

            let request = this.byId[record.reqId];
            if (request != null) {
                request.recvFrame = record.frame;
                if (record.outcome === "discarded") request.outcome = "stale";
            }
            return;
        }

        if (record.t === "apply" || record.t === "superseded" || record.t === "stale") {
            let request = this.byId[record.reqId];
            if (request != null) request.outcome = (record.t === "apply") ? "applied" : record.t;
            return;
        }

        if (record.t === "flap") {
            this.flaps.push(record.frame);
            if (this.flaps.length > 200) this.flaps.shift();
            //an applied FLAP is the only thing that reaches the game
            this.pulseAt = jevPanelNow();
            return;
        }

        if (record.t === "death") {
            this.deaths.push(record.frame);
            if (this.deaths.length > 8) this.deaths.shift();
        }
    }

    resetRun() {
        this.requests.length = 0;
        this.flaps.length = 0;
        this.deaths.length = 0;
        this.byId = {};
        this.nowFrame = 0;
        this.tokenThen = null;
        this.tokenNow = { frame: 0, tokens: 0 };
    }

    //anything older than the window is off the screen and out of every rate
    prune() {
        let cut = this.nowFrame - JEV_WINDOW_FRAMES;
        while (this.requests.length > 0) {
            let first = this.requests[0];
            if (first.sendFrame >= cut) break;
            //something still in the air stays, however old it looks
            if (first.recvFrame == null && first.sendFrame > cut - 300) break;
            delete this.byId[first.reqId];
            this.requests.shift();
        }
    }
    //#endregion

    //#region the numbers on the badges
    sendsInWindow() {
        let cut = this.nowFrame - JEV_WINDOW_FRAMES;
        let n = 0;
        for (let i = 0; i < this.requests.length; i++) {
            if (this.requests[i].sendFrame >= cut) n++;
        }
        return n;
    }

    inFlightCount() {
        let n = 0;
        for (let i = 0; i < this.requests.length; i++) {
            if (this.requests[i].recvFrame == null) n++;
        }
        return n;
    }

    // Tokens per minute off two samples of the session counter. The frames are the
    // clock: 60 of them is a second, same as everywhere else in the panel.
    tokensPerMinute(inputTokens) {
        if (!isFinite(inputTokens)) return null;

        if (inputTokens < this.tokenNow.tokens) this.tokenThen = null; //a fresh client
        this.tokenNow.tokens = inputTokens;
        this.tokenNow.frame = this.nowFrame;

        if (this.tokenThen == null) {
            this.tokenThen = { frame: this.nowFrame, tokens: inputTokens };
            return null;
        }

        let frames = this.nowFrame - this.tokenThen.frame;
        if (frames < 60) return null;

        let rate = (inputTokens - this.tokenThen.tokens) / (frames / JEV_FPS) * 60;

        //roll the older sample forward so the window stays 7.5-15 s
        if (frames > 900) this.tokenThen = { frame: this.nowFrame, tokens: inputTokens };

        return rate;
    }

    updateBadges(numbers) {
        let latency = numbers.latencyMs;
        this.setText("b:latency", this.badgeNodes.latency,
            latency != null ? Math.round(latency) + " ms" : "-");

        this.setText("b:lead", this.badgeNodes.lead,
            numbers.leadMs != null ? numbers.leadMs + " ms / " + numbers.leadFrames + "f" : "-");

        let rps = this.sendsInWindow() / (JEV_WINDOW_FRAMES / JEV_FPS);
        this.setText("b:rps", this.badgeNodes.rps, rps.toFixed(1));

        let tpm = this.tokensPerMinute(numbers.inputTokens);

        this.setText("b:tpm", this.badgeNodes.tpm, tpm != null ? Math.round(tpm) + "" : "-");
        this.setText("b:cost", this.badgeNodes.cost,
            tpm != null ? "$" + (tpm * 60 * JEV_INPUT_COST / 1e6).toFixed(3) : "-");

        this.setText("b:speed", this.badgeNodes.speed, numbers.timeScale != null ? "1/" + numbers.timeScale : "-");
    }
    //#endregion

    //#region drawing
    //nothing is drawn into a panel nobody can see
    isVisible() {
        if (this.destroyed) return false;
        if (typeof document.visibilityState === "string" && document.visibilityState !== "visible") return false;
        if (window.innerWidth <= 1000 && !this.root.classList.contains("is-open")) return false;
        return true;
    }

    //the css owns the width, so the backing store follows it and the dpr
    syncCanvas(canvas) {
        let w = canvas.el.clientWidth | 0;
        let dpr = window.devicePixelRatio || 1;
        if (w <= 0) return false;

        if (w !== canvas.w || dpr !== canvas.dpr) {
            canvas.w = w;
            canvas.dpr = dpr;
            canvas.el.width = Math.round(w * dpr);
            canvas.el.height = Math.round(canvas.h * dpr);
            this.cache.snapshotKey = null; //the schematic has to be repainted at the new size
        }

        canvas.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return true;
    }

    //the schematic only changes when a new snapshot went out, so it is keyed on the words
    drawSnapshot(described) {
        let canvas = this.snapshotCanvas;
        if (!this.syncCanvas(canvas)) return;

        let fields = described.fields;
        let key = fields == null ? "none" :
            fields.position + "|" + fields.motion + "|" + fields.above + "|" + fields.below + "|" + fields.distance;

        if (this.cache.snapshotKey === key) return;
        this.cache.snapshotKey = key;

        JevDashboard.drawSnapshot(canvas.ctx, fields, { w: canvas.w, h: canvas.h });
    }

    drawFlow(decision) {
        let canvas = this.flowCanvas;
        if (!this.syncCanvas(canvas)) return;

        let now = jevPanelNow();

        //#region the packets in the air
        this.packets.length = 0;
        for (let i = 0; i < this.requests.length; i++) {
            let request = this.requests[i];
            if (request.recvFrame != null) continue;
            this.packets.push((now - request.sentAt) / Math.max(60, this.latencyMs));
        }
        //#endregion

        //#region the bars, from the newest answer
        // A recv record carries a choice and a confidence but not the whole distribution.
        // The question is binary, so the other option gets the rest of the probability;
        // when the spent answer is the one that just landed we use its real numbers.
        let recv = this.lastRecv;
        let probabilities = (decision != null && decision.probabilities != null) ? decision.probabilities : null;
        let exact = probabilities != null && (recv == null || recv.choice === decision.choice);

        JEV_DECISION_OPTIONS.forEach(option => {
            if (exact && typeof probabilities[option] === "number") {
                this.bars[option] = probabilities[option];
            } else if (recv != null && typeof recv.confidence === "number") {
                this.bars[option] = recv.choice === option ? recv.confidence : 1 - recv.confidence;
            } else {
                this.bars[option] = null;
            }
        });
        //#endregion

        let model = this.flowModel;
        model.w = canvas.w;
        model.h = canvas.h;
        model.choice = recv != null ? recv.choice : null;
        model.spark = Math.max(0, 1 - (now - this.sparkAt) / JEV_PULSE_MS);
        model.pulse = Math.max(0, 1 - (now - this.pulseAt) / JEV_PULSE_MS);

        JevDashboard.drawFlow(canvas.ctx, model);
    }

    drawTimeline() {
        let canvas = this.timelineCanvas;
        if (!this.syncCanvas(canvas)) return;

        this.timelineModel.w = canvas.w;
        this.timelineModel.h = canvas.h;

        JevDashboard.drawTimeline(canvas.ctx, this.timelineModel, this.nowFrame);
    }
    //#endregion

    //#region the one call the scene makes
    update(view) {
        if (this.destroyed || view == null) return;

        this.frames++;

        if (this.cache.status !== view.status) {
            this.cache.status = view.status;
            this.root.setAttribute("data-status", view.status);
            this.statusLabel.textContent = view.status;
        }

        this.ingest(view.trace);

        //the scene tells us its frame; fall back to counting while live if it does not
        if (view.numbers != null && view.numbers.frame != null) this.nowFrame = view.numbers.frame;
        else if (view.status === "live") this.nowFrame++;

        let described = view.described || {};
        let numbers = view.numbers || {};

        //#region the slow half: words and numbers
        if (this.frames % JEV_BADGE_EVERY === 0) {
            this.updateBadges(numbers);

            let fields = described.fields;
            this.setText("w:position", this.positionWord, fields != null ? fields.position : "-");
            this.setText("w:motion", this.motionWord, fields != null ? fields.motion : "-");
            this.setText("described", this.describedLabel,
                "described at +" + (described.leadFrames != null ? described.leadFrames : 0) + "f");

            let applied = view.lastApplied;
            let confidence = (applied != null && typeof applied.confidence === "number") ?
                applied.confidence.toFixed(2) : "-";
            this.setText("decision", this.decisionWord,
                applied != null && applied.choice != null ? applied.choice + "  " + confidence : "-");

            JEV_COUNTERS.forEach(counter => {
                let value = numbers[counter.key];
                this.setText("c:" + counter.key, this.counterNodes[counter.key],
                    value != null ? String(value) : "-");
            });

            this.setText("inflight", this.inFlightLabel,
                "in flight " + (numbers.inFlight != null ? numbers.inFlight : this.inFlightCount()) +
                ", held " + (numbers.held != null ? numbers.held : "-"));
        }
        //#endregion

        if (!this.isVisible()) return;

        //#region the fast half: one repaint per frame, no more
        this.drawSnapshot(described);
        this.drawFlow(view.decision);
        this.drawTimeline();
        //#endregion

        if (this.traceFold.classList.contains("is-open")) this.updateTrace(view.trace);
    }
    //#endregion

    // The log only ever grows, so its sequence number is enough to know whether
    // anything happened; nothing touches the DOM on a quiet frame.
    updateTrace(trace) {
        if (trace == null) return;
        if (this.cache.traceSeq === trace.seq) return;
        this.cache.traceSeq = trace.seq;

        let entries = trace.entries || [];
        let recent = entries.slice(Math.max(0, entries.length - JEV_TRACE_SHOWN));

        let lines = [];
        recent.forEach(record => {
            jevTraceLines(record).forEach(line => lines.push(line));
        });

        this.traceLog.textContent = lines.join("\n");
        //newest at the bottom, so keep the view pinned there
        this.traceLog.scrollTop = this.traceLog.scrollHeight;
    }

    downloadTrace() {
        if (this.getTraceFile == null) return;

        let file = this.getTraceFile();
        if (file == null || file.text == null) return;

        let blob = new Blob([file.text], { type: "application/x-ndjson" });
        let url = URL.createObjectURL(blob);

        let link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        //the blob would otherwise stay alive for the whole session
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;

        window.removeEventListener("resize", this.onResize);
        if (this.root != null && this.root.parentNode != null) {
            this.root.parentNode.removeChild(this.root);
        }
        this.root = null;
    }
}
