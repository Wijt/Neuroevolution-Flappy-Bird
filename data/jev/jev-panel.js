// The side panel that shows what Jev is thinking.
// Plain DOM on purpose: p5 0.10.2's createDiv() is clumsy for something this nested,
// and the panel must never touch the canvas.
const JEV_MANEUVER_OPTIONS = [
    "let_it_fall",
    "one_hop",
    "two_hops",
    "climb_hard"
];

const JEV_READ_OPTIONS = [
    "too_high",
    "aligned",
    "too_low",
    "entering_pipe_misaligned",
    "ground_danger",
    "ceiling_danger"
];

const JEV_SCENE_ROWS = [
    { key: "vertical_motion", label: "motion" },
    { key: "place_in_gap", label: "place" },
    { key: "last_flap", label: "last flap" },
    { key: "surroundings", label: "around" },
    { key: "distance", label: "pipe ahead" },
    { key: "following_gap", label: "next gap" }
];

const JEV_DANGER_LEVELS = [
    "comfortably safe",
    "needs a correction soon",
    "one wrong move from a collision",
    "collision nearly unavoidable"
];

const JEV_META_ROWS = [
    { key: "inFlight", label: "in flight" },
    { key: "requests", label: "requests" },
    { key: "tokens", label: "tokens" },
    { key: "latency", label: "last latency" },
    { key: "discarded", label: "discarded" },
    { key: "errors", label: "errors" }
];

class JevPanel {
    constructor(getRect) {
        this.getRect = getRect;
        this.destroyed = false;
        this.cache = {};

        this.fieldNodes = {};
        this.maneuverNodes = {};
        this.readNodes = {};
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

        this.dot = document.createElement("span");
        this.dot.className = "jev-dot";
        header.appendChild(this.dot);

        header.addEventListener("click", () => {
            this.root.classList.toggle("is-open");
        });
        this.root.appendChild(header);
        //#endregion

        //#region scene fields
        this.root.appendChild(this.makeTitle("scene"));

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
        this.root.appendChild(this.wrap(list));
        //#endregion

        //#region maneuver
        this.root.appendChild(this.makeTitle("maneuver"));

        let maneuverBox = document.createElement("div");
        maneuverBox.appendChild(this.makeOptionList(JEV_MANEUVER_OPTIONS, this.maneuverNodes));

        this.planLabel = document.createElement("div");
        this.planLabel.className = "jev-val";
        this.planLabel.textContent = "plan: none";
        maneuverBox.appendChild(this.planLabel);

        this.root.appendChild(this.wrap(maneuverBox));
        //#endregion

        //#region read
        this.root.appendChild(this.makeTitle("read"));
        this.root.appendChild(this.wrap(this.makeOptionList(JEV_READ_OPTIONS, this.readNodes)));
        //#endregion

        //#region danger
        this.root.appendChild(this.makeTitle("danger"));
        this.dangerLabel = document.createElement("div");
        this.dangerLabel.className = "jev-val";
        this.dangerLabel.textContent = "-";
        this.root.appendChild(this.wrap(this.dangerLabel));
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

        document.body.appendChild(this.root);
    }

    // one fixed-order list of options with a mini bar and a probability each,
    // used by both the maneuver and the read section
    makeOptionList(options, nodes) {
        let list = document.createElement("div");
        list.className = "jev-read";

        options.forEach(option => {
            let row = document.createElement("div");
            row.className = "jev-read-row";

            let name = document.createElement("span");
            name.className = "jev-read-name";
            name.textContent = option.split("_").join(" ");

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

    planText(plan) {
        if (plan == null || !(plan.hopsRemaining > 0)) return "plan: none";

        let hops = plan.hopsRemaining + (plan.hopsRemaining === 1 ? " hop left" : " hops left");
        let frames = plan.nextHopIn + (plan.nextHopIn === 1 ? " frame" : " frames");
        return "plan: " + hops + ", next in " + frames;
    }

    update(view) {
        if (this.destroyed || view == null) return;

        if (this.cache.status !== view.status) {
            this.cache.status = view.status;
            this.root.setAttribute("data-status", view.status);
        }

        //#region scene fields
        let fields = view.fields;
        JEV_SCENE_ROWS.forEach(row => {
            let value = (fields != null && fields[row.key] != null) ? fields[row.key] : "-";
            this.setText("f:" + row.key, this.fieldNodes[row.key], value);
        });
        //#endregion

        //#region maneuver
        this.updateOptionList("mv", JEV_MANEUVER_OPTIONS, this.maneuverNodes, view.maneuver);
        this.setText("plan", this.planLabel, this.planText(view.plan));
        //#endregion

        //#region read
        this.updateOptionList("r", JEV_READ_OPTIONS, this.readNodes, view.read);
        //#endregion

        //#region danger
        let score = (view.danger != null && typeof view.danger.score === "number") ? view.danger.score : null;
        if (score == null) {
            this.setText("danger", this.dangerLabel, "-");
        } else {
            let level = Math.max(0, Math.min(JEV_DANGER_LEVELS.length - 1, Math.round(score)));
            this.setText("danger", this.dangerLabel, score.toFixed(1) + " / 3  " + JEV_DANGER_LEVELS[level]);
        }
        //#endregion

        //#region meta
        let meta = view.meta || {};
        JEV_META_ROWS.forEach(row => {
            let value = (meta[row.key] != null) ? String(meta[row.key]) : "-";
            this.setText("m:" + row.key, this.metaNodes[row.key], value);
        });
        //#endregion
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
