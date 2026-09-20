// The three little drawings in the Jev panel.
// Nothing in here knows about the DOM, the game or the client: you hand it a 2d
// context, a size and a plain model, it paints. That keeps the panel free to worry
// about when to draw and this file free to worry about what it looks like.
var JevDashboard = (function () {
    //#region palette
    //the game's colours plus the few greys the structure needs
    var INK = "#dfe6f3";
    var DIM = "#7b90b4";
    var FAINT = "#5b6d92";
    var LINE = "#2a3a63";
    var WELL = "#10101f";

    var PIPE = "#1f4068";
    var BIRD = "#e43f5a";
    var COOL = "#4f8a8b";

    var OK = "#4c9f70";
    var WARN = "#e8a33d";
    var BAD = "#e43f5a";
    var FLIGHT = "#56618a";
    //#endregion

    //#region small helpers
    function font(ctx, size) {
        ctx.font = size + "px Consolas, Menlo, monospace";
    }

    function label(ctx, text, x, y, colour, size, align) {
        font(ctx, size);
        ctx.fillStyle = colour;
        ctx.textAlign = align || "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x, y);
    }

    function line(ctx, x1, y1, x2, y2, colour, width) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width || 1;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }

    //a line with a head on it; dx/dy only ever point along one axis here
    function arrow(ctx, x1, y1, x2, y2, colour, width) {
        line(ctx, x1, y1, x2, y2, colour, width);

        var dx = x2 - x1;
        var dy = y2 - y1;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) return;

        dx /= len;
        dy /= len;

        ctx.fillStyle = colour;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - dx * 5 - dy * 3, y2 - dy * 5 + dx * 3);
        ctx.lineTo(x2 - dx * 5 + dy * 3, y2 - dy * 5 - dx * 3);
        ctx.closePath();
        ctx.fill();
    }

    function clamp(n, lo, hi) {
        return n < lo ? lo : (n > hi ? hi : n);
    }

    function number(n, fallback) {
        return (typeof n === "number" && isFinite(n)) ? n : fallback;
    }

    function note(ctx, w, h, text) {
        label(ctx, text, w / 2, h / 2, FAINT, 10, "center");
    }

    //every drawing starts from an empty, opaque well
    function well(ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = WELL;
        ctx.fillRect(0, 0, w, h);
    }
    //#endregion

    //#region what jev sees
    //the arrow next to the bird is as long as the word is strong
    function motionPull(motion) {
        if (motion === "rising") return -24;
        if (motion === "falling") return 15;
        if (motion === "falling fast") return 27;
        return 0; // level
    }

    // fields is the described snapshot: { position, motion, above, below, distance }.
    // above/below are clearances in px, negative when the bird is past that edge, so the
    // bird's y falls out of them and no separate position is needed.
    function drawSnapshot(ctx, fields, opts) {
        var h = opts.h;

        well(ctx, opts.w, h);

        if (fields == null) {
            note(ctx, opts.w, h, "no snapshot yet");
            return;
        }

        //a docked panel is much wider than this drawing wants to be, so it stays centred
        var w = Math.min(opts.w, 300);
        var inset = (opts.w - w) / 2;
        if (inset > 0) ctx.translate(inset, 0);

        var r = (typeof JEV_COLLISION_R === "number") ? JEV_COLLISION_R : 15;
        var above = number(fields.above, 0);
        var below = number(fields.below, 0);

        //the gap is whatever the two clearances and the bird add up to
        var gapPx = above + below + 2 * r;
        if (!(gapPx > 10)) gapPx = 125;

        var gapH = 58; // the gap is always drawn this tall, the scale follows
        var scale = gapH / gapPx;

        var top = 59;
        var bottom = top + gapH;
        var floor = 160;

        //#region the pipe column
        var px = w - 52;
        var pw = 30;

        ctx.fillStyle = PIPE;
        ctx.fillRect(px, 4, pw, top - 4);
        ctx.fillRect(px, bottom, pw, floor - bottom);

        label(ctx, "gap", px + pw / 2, (top + bottom) / 2, FAINT, 9, "center");
        //#endregion

        //#region the bird where the clearances put it
        var birdX = 40;
        var birdY = clamp(top + (above + r) * scale, 12, floor - 12);
        var birdR = clamp(r * scale, 3, 9);

        ctx.fillStyle = BIRD;
        ctx.beginPath();
        ctx.arc(birdX, birdY, birdR, 0, Math.PI * 2);
        ctx.fill();
        //#endregion

        //#region the motion arrow
        var pull = motionPull(fields.motion);
        if (pull === 0) {
            line(ctx, birdX - 20, birdY, birdX - 8, birdY, COOL, 2);
        } else {
            arrow(ctx, birdX - 14, birdY, birdX - 14, birdY + pull, pull < 0 ? COOL : BIRD, 2);
        }
        //#endregion

        //#region the two bracketed clearances
        bracket(ctx, 74, top, birdY - birdR, above, "above");
        bracket(ctx, 74, birdY + birdR, bottom, below, "below");
        //#endregion

        //#region the ruler to the pipe
        var ruler = floor + 18;
        var distance = number(fields.distance, 0);

        line(ctx, birdX, ruler, px, ruler, LINE, 1);
        line(ctx, birdX, ruler - 4, birdX, ruler + 4, LINE, 1);
        line(ctx, px, ruler - 4, px, ruler + 4, LINE, 1);
        label(ctx, distance + " px to pipe", (birdX + px) / 2, ruler - 12, DIM, 10, "center");
        //#endregion

        if (inset > 0) ctx.translate(-inset, 0);
    }

    //a clearance: a hairline with a tick at each end and the number beside it
    function bracket(ctx, x, y1, y2, value, name) {
        var colour = value < 0 ? BAD : OK;

        line(ctx, x, y1, x, y2, colour, 1);
        line(ctx, x - 4, y1, x + 4, y1, colour, 1);
        line(ctx, x - 4, y2, x + 4, y2, colour, 1);

        label(ctx, name + " " + value, x + 8, (y1 + y2) / 2, colour, 10, "left");
    }
    //#endregion

    //#region decision flow
    var FLOW_NODES = ["Snapshot", "Question", "Jev", "Action"];

    // model: { w, h, packets: [0..1], bars: {FLAP, WAIT}, choice, pulse: 0..1, spark: 0..1 }
    // packets are the requests in the air, one number each: how far along they are.
    function drawFlow(ctx, model) {
        var w = model.w;
        var h = model.h;

        well(ctx, w, h);

        //#region the four nodes
        var gap = 9;
        var right = 26; // the strip the action -> game arrow lives in
        var nodeW = (w - 12 - right - gap * 3) / 4;
        var nodeY = 12;
        var nodeH = 22;
        var midY = nodeY + nodeH / 2;

        var cx = [0, 0, 0, 0];
        for (var i = 0; i < 4; i++) {
            var x = 6 + i * (nodeW + gap);
            cx[i] = x + nodeW / 2;

            var hot = (i === 2 && model.spark > 0) || (i === 3 && model.pulse > 0);

            ctx.fillStyle = hot ? "#1c2c4e" : "#161a2e";
            ctx.fillRect(x, nodeY, nodeW, nodeH);

            ctx.strokeStyle = hot ? COOL : LINE;
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, nodeY + 0.5, nodeW - 1, nodeH - 1);

            label(ctx, FLOW_NODES[i], cx[i], midY, hot ? INK : DIM, 9, "center");

            if (i > 0) arrow(ctx, cx[i - 1] + nodeW / 2 + 1, midY, x - 2, midY, LINE, 1);
        }
        //#endregion

        //#region the action -> game edge, pulsing on an applied flap
        var edgeX = 6 + 3 * (nodeW + gap) + nodeW;
        var pulse = model.pulse > 0 ? model.pulse : 0;
        arrow(ctx, edgeX + 2, midY, w - 6, midY, pulse > 0 ? BIRD : LINE, pulse > 0 ? 2 : 1);
        label(ctx, "game", w - 6, midY + 14, pulse > 0 ? BIRD : FAINT, 8, "right");
        //#endregion

        //#region the packets in the air
        var packets = model.packets || [];
        for (var k = 0; k < packets.length; k++) {
            var p = clamp(packets[k], 0, 1);
            var dotX = cx[0] + (cx[2] - cx[0]) * p;

            ctx.fillStyle = COOL;
            ctx.globalAlpha = 0.4 + 0.6 * (1 - p);
            ctx.beginPath();
            ctx.arc(dotX, midY, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        //#endregion

        //#region the two bars the answer came back with
        var bars = model.bars || {};
        bar(ctx, w, 58, "FLAP", bars.FLAP, BIRD, model.choice === "FLAP");
        bar(ctx, w, 82, "WAIT", bars.WAIT, COOL, model.choice === "WAIT");
        //#endregion
    }

    function bar(ctx, w, y, name, value, colour, isChoice) {
        var x = 42;
        var full = w - x - 34;
        var high = 10;

        label(ctx, name, 6, y + high / 2, isChoice ? INK : DIM, 10, "left");

        ctx.fillStyle = "#161a2e";
        ctx.fillRect(x, y, full, high);

        if (typeof value === "number" && isFinite(value)) {
            ctx.fillStyle = colour;
            ctx.globalAlpha = isChoice ? 1 : 0.5;
            ctx.fillRect(x, y, Math.max(1, full * clamp(value, 0, 1)), high);
            ctx.globalAlpha = 1;

            label(ctx, value.toFixed(2), w - 6, y + high / 2, isChoice ? INK : DIM, 10, "right");
        } else {
            label(ctx, "-", w - 6, y + high / 2, FAINT, 10, "right");
        }
    }
    //#endregion

    //#region pipeline
    var LANES = 8;
    var laneEnd = [0, 0, 0, 0, 0, 0, 0, 0]; // reused, the timeline redraws every frame

    function outcomeColour(outcome) {
        if (outcome === "applied") return OK;
        if (outcome === "superseded") return WARN;
        if (outcome === "stale") return BAD;
        return FLIGHT;
    }

    // records: { w, h, window, requests: [{reqId, sendFrame, recvFrame, outcome}], flaps: [frame], deaths: [frame] }
    // One bar per request from its send to its answer, stacked so overlapping requests
    // stay apart. This is the whole point of the section: seeing them overlap.
    function drawTimeline(ctx, records, nowFrame) {
        var w = records.w;
        var h = records.h;
        var span = records.window || 300;

        well(ctx, w, h);

        var x0 = 6;
        var x1 = w - 6;
        var from = nowFrame - span;
        var scale = (x1 - x0) / span;

        function at(frame) {
            return clamp(x0 + (frame - from) * scale, x0, x1);
        }

        //#region the band
        var top = 8;
        var laneH = 4;

        ctx.fillStyle = "#141426";
        ctx.fillRect(x0, top, x1 - x0, LANES * laneH);

        for (var l = 0; l < LANES; l++) laneEnd[l] = -1e9;
        //#endregion

        //#region one bar per request
        var requests = records.requests || [];
        for (var i = 0; i < requests.length; i++) {
            var req = requests[i];
            if (req.sendFrame < from - 60) continue;

            var end = req.recvFrame != null ? req.recvFrame : nowFrame;

            var lane = LANES - 1;
            for (var j = 0; j < LANES; j++) {
                if (laneEnd[j] <= req.sendFrame) { lane = j; break; }
            }
            laneEnd[lane] = end + 1;

            var bx = at(req.sendFrame);
            var bw = Math.max(1.5, at(end) - bx);

            ctx.fillStyle = outcomeColour(req.outcome);
            ctx.globalAlpha = req.outcome == null ? 0.7 : 1;
            ctx.fillRect(bx, top + lane * laneH, bw, laneH - 1.5);
            ctx.globalAlpha = 1;
        }
        //#endregion

        //#region flaps along the bottom edge, deaths straight through
        var tick = top + LANES * laneH + 3;
        var flaps = records.flaps || [];
        ctx.fillStyle = BIRD;
        for (var f = 0; f < flaps.length; f++) {
            if (flaps[f] < from) continue;
            ctx.fillRect(at(flaps[f]), tick, 1.5, 7);
        }

        var deaths = records.deaths || [];
        for (var d = 0; d < deaths.length; d++) {
            if (deaths[d] < from) continue;
            line(ctx, at(deaths[d]), top, at(deaths[d]), tick + 7, "#ffffff", 1);
        }
        //#endregion

        //#region legend
        var y = h - 8;
        key(ctx, 6, y, OK, "applied");
        key(ctx, 62, y, WARN, "superseded");
        key(ctx, 138, y, BAD, "stale");
        key(ctx, 180, y, FLIGHT, "in flight");
        label(ctx, "-" + span + "f", x1, y, FAINT, 8, "right");
        //#endregion
    }

    function key(ctx, x, y, colour, text) {
        ctx.fillStyle = colour;
        ctx.fillRect(x, y - 2, 5, 5);
        label(ctx, text, x + 8, y, FAINT, 8, "left");
    }
    //#endregion

    return {
        drawSnapshot: drawSnapshot,
        drawFlow: drawFlow,
        drawTimeline: drawTimeline
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevDashboard = JevDashboard;
