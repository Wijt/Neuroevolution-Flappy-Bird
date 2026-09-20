// The side panel that shows what Jev is thinking.
// Plain DOM on purpose: p5 0.10.2's createDiv() is clumsy for something this nested,
// and the panel must never touch the canvas.
//
// v2 shows three things and no more: the scene we described in the last request
// (which is the world as it will be, not as it is), the answer the loop last spent,
// and the bookkeeping that says whether the timing is working.
const JEV_DECISION_OPTIONS = [
    "FLAP",
    "WAIT"
];

const JEV_SCENE_ROWS = [
    { key: "position", label: "position" },
    { key: "motion", label: "motion" },
    { key: "above", label: "above" },
    { key: "below", label: "below" },
    { key: "distance", label: "pipe ahead" }
];

const JEV_META_ROWS = [
    { key: "inFlight", label: "in flight" },
    { key: "sent", label: "sent" },
    { key: "applied", label: "applied" },
    { key: "superseded", label: "superseded" },
    { key: "stale", label: "stale" },
    { key: "lead", label: "lead" },
    { key: "latency", label: "last latency" },
    { key: "tokens", label: "tokens" },
    { key: "errors", label: "errors" },
    { key: "speed", label: "speed" }
];

//how many trace lines the panel keeps on screen, the log itself is much longer
const JEV_TRACE_SHOWN = 12;

//the timeline says "lower half", the snapshot says "inside the gap, lower half"
const JEV_POSITION_SHORT = {
    "above the gap": "above gap",
    "below the gap": "below gap",
    "inside the gap, upper half": "upper half",
    "inside the gap, lower half": "lower half"
};

//#region trace formatting
// Same shapes the harness prints, so a browser trace and a headless one line up.
function jevFrameTag(frame) {
    let s = String(frame);
    while (s.length < 4) s = "0" + s;
    return "f" + s;
}

function jevPad(text, width) {
    let s = String(text);
    while (s.length < width) s = s + " ";
    return s;
}

function jevPadLeft(text, width) {
    let s = String(text);
    while (s.length < width) s = " " + s;
    return s;
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
            ", late " + record.lateFrames + "f, speed 1/" + record.timeScale +
            ", translator " + record.translator];
    }

    if (record.t === "send") {
        let fields = record.fields || {};
        let actual = record.actual || {};

        return [jevFrameTag(record.frame) + " send " + jevPad("#" + record.reqId, 4) +
            " ->" + jevFrameTag(record.targetFrame) + " (" + record.leadFrames + "f)" +
            " y=" + jevPadLeft(Math.round(actual.birdY), 3) +
            " v=" + jevPadLeft(Number(actual.vel).toFixed(1), 5) +
            " | " + jevShortPosition(fields.position) +
            " | " + (fields.motion != null ? fields.motion : "-") +
            " | dist " + (fields.distance != null ? fields.distance : "-")];
    }

    if (record.t === "recv") {
        let choice = record.choice || "?";
        let p = (record.probs != null && record.choice != null) ? record.probs[record.choice] : null;

        return [jevFrameTag(record.frame) + " recv " + jevPad("#" + record.reqId, 4) +
            " (" + record.latencyMs + "ms) " + choice + " " + jevProb(p) +
            " " + record.outcome];
    }

    if (record.t === "apply") {
        return [jevFrameTag(record.frame) + " apply " + jevPad("#" + record.reqId, 4) +
            " " + (record.choice || "?") + " (" + record.lateBy + "f late)"];
    }

    if (record.t === "stale") {
        return [jevFrameTag(record.frame) + " stale " + jevPad("#" + record.reqId, 4) +
            " ->" + jevFrameTag(record.targetFrame)];
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

class JevPanel {
    constructor(getRect, getTraceFile) {
        this.getRect = getRect;
        this.getTraceFile = getTraceFile;
        this.destroyed = false;
        this.cache = {};

        this.fieldNodes = {};
        this.decisionNodes = {};
        this.metaNodes = {};

        this.build();

        this.onResize = () => {
            if (this.destroyed) return;
            this.layout(this.getRect ? this.getRect() : null);
        };
        window.addEventListener("resize", this.onResize);

        this.layout(this.getRect ? this.getRect() : null);
    }

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

        header.addEventListener("click", () => {
            this.root.classList.toggle("is-open");
        });
        this.root.appendChild(header);
        //#endregion

        //#region scene fields
        this.root.appendChild(this.makeTitle("scene"));

        let sceneBox = document.createElement("div");

        //the numbers are the predicted world, saying so avoids a lot of confusion
        this.describedLabel = document.createElement("div");
        this.describedLabel.className = "jev-dim";
        this.describedLabel.textContent = "described (at +0f)";
        sceneBox.appendChild(this.describedLabel);

        let list = document.createElement("dl");
        list.className = "jev-dl";
        JEV_SCENE_ROWS.forEach(row => {
            let term = document.createElement("dt");
            term.textContent = row.label;
            let value = document.createElement("dd");
            value.textContent = "-";
            list.appendChild(term);
            list.appendChild(value);
            this.fieldNodes[row.key] = value;
        });
        sceneBox.appendChild(list);

        this.root.appendChild(this.wrap(sceneBox));
        //#endregion

        //#region decision
        this.root.appendChild(this.makeTitle("decision"));

        let decisionBox = document.createElement("div");
        decisionBox.appendChild(this.makeOptionList(JEV_DECISION_OPTIONS, this.decisionNodes));

        this.confidenceLabel = document.createElement("div");
        this.confidenceLabel.className = "jev-val";
        this.confidenceLabel.textContent = "confidence -";
        decisionBox.appendChild(this.confidenceLabel);

        this.appliedLabel = document.createElement("div");
        this.appliedLabel.className = "jev-dim";
        this.appliedLabel.textContent = "last applied: none";
        decisionBox.appendChild(this.appliedLabel);

        this.root.appendChild(this.wrap(decisionBox));
        //#endregion

        //#region meta
        this.root.appendChild(this.makeTitle("meta"));
        let meta = document.createElement("dl");
        meta.className = "jev-dl";
        JEV_META_ROWS.forEach(row => {
            let term = document.createElement("dt");
            term.textContent = row.label;
            let value = document.createElement("dd");
            value.textContent = "-";
            meta.appendChild(term);
            meta.appendChild(value);
            this.metaNodes[row.key] = value;
        });
        this.root.appendChild(this.wrap(meta));
        //#endregion

        //#region trace
        this.root.appendChild(this.makeTitle("trace"));

        let traceBox = document.createElement("div");

        let legend = document.createElement("div");
        legend.className = "jev-legend";
        legend.textContent = "P pause  N step  M next event";
        traceBox.appendChild(legend);

        this.traceLog = document.createElement("div");
        this.traceLog.className = "jev-trace";
        traceBox.appendChild(this.traceLog);

        this.downloadButton = document.createElement("button");
        this.downloadButton.className = "jev-download";
        this.downloadButton.type = "button";
        this.downloadButton.textContent = "download trace";
        this.downloadButton.addEventListener("click", () => this.downloadTrace());
        traceBox.appendChild(this.downloadButton);

        this.root.appendChild(this.wrap(traceBox));
        //#endregion

        document.body.appendChild(this.root);
    }

    // one fixed-order list of options with a mini bar and a probability each
    makeOptionList(options, nodes) {
        let list = document.createElement("div");
        list.className = "jev-read";

        options.forEach(option => {
            let row = document.createElement("div");
            row.className = "jev-read-row";

            let name = document.createElement("span");
            name.className = "jev-read-name";
            name.textContent = option;

            let mini = document.createElement("span");
            mini.className = "jev-mini";
            let miniFill = document.createElement("span");
            miniFill.className = "jev-mini-fill";
            mini.appendChild(miniFill);

            let prob = document.createElement("span");
            prob.className = "jev-read-p";
            prob.textContent = "-";

            row.appendChild(name);
            row.appendChild(mini);
            row.appendChild(prob);
            list.appendChild(row);

            nodes[option] = { row: row, fill: miniFill, prob: prob };
        });

        return list;
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

    setText(key, node, value) {
        if (this.cache[key] === value) return;
        this.cache[key] = value;
        node.textContent = value;
    }

    setWidth(key, node, value) {
        if (this.cache[key] === value) return;
        this.cache[key] = value;
        node.style.width = value;
    }

    setChoice(key, node, isChoice) {
        if (this.cache[key] === isChoice) return;
        this.cache[key] = isChoice;
        if (isChoice) node.classList.add("is-choice");
        else node.classList.remove("is-choice");
    }

    // answer is a choice answer: { choice, probabilities }
    updateOptionList(prefix, options, nodes, answer) {
        let probabilities = (answer != null && answer.probabilities != null) ? answer.probabilities : null;

        options.forEach(option => {
            let node = nodes[option];
            let p = (probabilities != null && typeof probabilities[option] === "number") ? probabilities[option] : null;
            if (p == null) {
                this.setWidth(prefix + ":" + option + ":w", node.fill, "0%");
                this.setText(prefix + ":" + option + ":p", node.prob, "-");
            } else {
                this.setWidth(prefix + ":" + option + ":w", node.fill, Math.round(p * 100) + "%");
                this.setText(prefix + ":" + option + ":p", node.prob, p.toFixed(2));
            }
            this.setChoice(prefix + ":" + option + ":c", node.row, answer != null && answer.choice === option);
        });
    }

    appliedText(applied) {
        if (applied == null || applied.choice == null) return "last applied: none";

        return "last applied: " + applied.choice + " #" + applied.reqId +
            ", " + applied.lateBy + "f late";
    }

    update(view) {
        if (this.destroyed || view == null) return;

        if (this.cache.status !== view.status) {
            this.cache.status = view.status;
            this.root.setAttribute("data-status", view.status);
            this.statusLabel.textContent = view.status;
        }

        //#region scene fields
        let described = view.described || {};
        let fields = described.fields;

        this.setText("described", this.describedLabel,
            "described (at +" + (described.leadFrames != null ? described.leadFrames : 0) + "f)");

        JEV_SCENE_ROWS.forEach(row => {
            let value = (fields != null && fields[row.key] != null) ? String(fields[row.key]) : "-";
            this.setText("f:" + row.key, this.fieldNodes[row.key], value);
        });
        //#endregion

        //#region decision
        this.updateOptionList("d", JEV_DECISION_OPTIONS, this.decisionNodes, view.decision);

        let confidence = (view.decision != null && typeof view.decision.confidence === "number") ?
            view.decision.confidence.toFixed(2) : "-";
        this.setText("confidence", this.confidenceLabel, "confidence " + confidence);

        this.setText("applied", this.appliedLabel, this.appliedText(view.lastApplied));
        //#endregion

        //#region meta
        let meta = view.meta || {};
        JEV_META_ROWS.forEach(row => {
            let value = (meta[row.key] != null) ? String(meta[row.key]) : "-";
            this.setText("m:" + row.key, this.metaNodes[row.key], value);
        });
        //#endregion

        //#region trace
        this.updateTrace(view.trace);
        //#endregion
    }

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
