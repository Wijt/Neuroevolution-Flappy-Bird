// The Jev HUD: everything the pilot is doing, drawn straight on the canvas.
// No DOM and no libraries. The scene hands us itself once per draw and we paint;
// nothing in here changes the world, so the HUD can be switched off without the
// flight noticing.
//
// It is an interpretation drawn over the game, not more game art: outlines, hairlines
// and two low tints, so the only solid red thing on screen is still the bird. The
// decision sits where the situation is, beside the ghost, and is the loudest text the
// HUD has. The telemetry is two thin bands, one under the score and one on the ground,
// and they are meant to read last.
//
// Three levels, cycled with a tap or H. 2 is the whole thing, 1 keeps only what Jev
// sees, 0 is off. Every size comes off `width`, so a 375 px phone and a 500 px desktop
// canvas both read; the vertical offsets hang off the score block, which the scene
// always draws at a fixed 60 px.
//#region palette
//four HUD colours and nothing else: the game's own plus amber and green
const JEV_HUD_COOL = "#4f8a8b";
const JEV_HUD_SUPERSEDED = "#ffb020";
const JEV_HUD_APPLIED = "#3ddc84";

//the quiet grey the labels are written in
const JEV_HUD_LABEL = "#8fa6c8";
//#endregion

//#region looks
//numbers are monospace, words are not
const JEV_HUD_MONO = "ui-monospace, Consolas, Menlo, monospace";
const JEV_HUD_SANS = "sans-serif";

//the motion arrow never grows past this, whatever the velocity says
const JEV_HUD_ARROW_MAX = 40;

//px of arrow per px of velocity per game frame
const JEV_HUD_ARROW_SCALE = 6;

//an applied flap lights the action edge for this many frames, the only effect there is
const JEV_HUD_FLASH = 6;

//the tap hint is a first impression, not a fixture
const JEV_HUD_HINT_MS = 3000;
//#endregion

//#region pipeline
//the timeline, the packets and the rates all look at this many draw frames
const JEV_HUD_WINDOW = 300;

//how many requests may be stacked before the oldest lane is reused. The band is
//thin, so four lanes that can be seen beat eight that cannot
const JEV_HUD_LANES = 4;

//what an input token costs, in dollars per million
const JEV_HUD_INPUT_COST = 0.042;
//#endregion

//how many levels there are to cycle through: 2 full, 1 minimal, 0 off
const JEV_HUD_LEVELS = 3;

//the return button sits bottom left, so the ground strip starts clear of it
const JEV_HUD_LEFT_CLEAR = 60;

var JevHud = (function () {
    //one clock, same fallback the scene uses
    function now() {
        return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }

    function clamp(n, lo, hi) {
        return n < lo ? lo : (n > hi ? hi : n);
    }

    //#region the palette, built once
    // color() allocates and the HUD draws every frame, so the whole palette is made
    // on the first draw and kept. It cannot be made up front, p5 is not running yet.
    var COLORS = null;

    function ensureColors() {
        if (COLORS != null) return;

        let ghost = color(BIRD_COLOR);
        ghost.setAlpha(190);

        let danger = color(BIRD_COLOR);
        danger.setAlpha(210);

        let lowerHalf = color(BIRD_COLOR);
        lowerHalf.setAlpha(55);

        let upperHalf = color(JEV_HUD_COOL);
        upperHalf.setAlpha(55);

        let label = color(JEV_HUD_LABEL);
        label.setAlpha(180);

        COLORS = {
            ghost: ghost,
            danger: danger,
            lowerHalf: lowerHalf,
            upperHalf: upperHalf,
            label: label,
            //structure lives between a quarter and a half of white
            hair: color(255, 255, 255, 70),
            line: color(255, 255, 255, 110),
            value: color(255, 255, 255, 235),
            flap: color(BIRD_COLOR),
            wait: color(JEV_HUD_COOL),
            applied: color(JEV_HUD_APPLIED),
            superseded: color(JEV_HUD_SUPERSEDED),
            stale: color(BIRD_COLOR),
            inFlight: color(255, 255, 255, 75),
            well: color(0, 0, 0, 70),
            box: color(0, 0, 0, 60),
            //the only colour that is ever re-tinted, so nothing else reads it
            packet: color(JEV_HUD_COOL)
        };
    }

    //a hairline that says "drawn by the pilot", not "part of the world"
    function dashed(on) {
        if (typeof drawingContext === "undefined" || drawingContext.setLineDash == null) return;
        drawingContext.setLineDash(on ? [4, 4] : []);
    }
    //#endregion

    //#region reading the trace tail
    // One entry per request inside the window, kept as parallel numbers so a frame of
    // drawing allocates nothing. The trace is appended in order, so we walk back from
    // the end until a record falls out of the window (or a header starts a new run,
    // where the frame counter goes back to zero) and then forward once from there.
    var reqId = [];
    var reqSend = [];
    var reqRecv = []; // -1 while it is still in the air
    var reqOutcome = []; // 0 in flight, 1 applied, 2 superseded, 3 stale
    var flaps = [];
    var deaths = [];

    //how many requests went out inside the window, for the rate on the badge row
    var sends = 0;

    var laneEnd = [];

    function findRequest(id) {
        //an answer lands close behind its send, so the tail is the short way round
        for (let i = reqId.length - 1; i >= 0; i--) {
            if (reqId[i] === id) return i;
        }
        return -1;
    }

    function readTail(scene) {
        let trace = scene.trace;
        let from = scene.frame - JEV_HUD_WINDOW;

        let start = trace.length;
        while (start > 0) {
            let record = trace[start - 1];
            if (record.t === "header") break;
            if (typeof record.frame === "number" && record.frame < from) break;
            start--;
        }

        reqId.length = 0;
        reqSend.length = 0;
        reqRecv.length = 0;
        reqOutcome.length = 0;
        flaps.length = 0;
        deaths.length = 0;
        sends = 0;

        for (let i = start; i < trace.length; i++) {
            let record = trace[i];

            if (record.t === "send") {
                reqId.push(record.reqId);
                reqSend.push(record.frame);
                reqRecv.push(-1);
                reqOutcome.push(0);
                sends++;
                continue;
            }

            if (record.t === "flap") {
                flaps.push(record.frame);
                continue;
            }

            if (record.t === "death") {
                deaths.push(record.frame);
                continue;
            }

            if (record.t === "recv") {
                let at = findRequest(record.reqId);
                if (at !== -1) {
                    reqRecv[at] = record.frame;
                    if (record.outcome === "discarded") reqOutcome[at] = 3;
                }
                continue;
            }

            if (record.t === "apply" || record.t === "superseded" || record.t === "stale") {
                let at = findRequest(record.reqId);
                if (at !== -1) reqOutcome[at] = record.t === "apply" ? 1 : (record.t === "superseded" ? 2 : 3);
            }
        }
    }

    function outcomeColor(code) {
        if (code === 1) return COLORS.applied;
        if (code === 2) return COLORS.superseded;
        if (code === 3) return COLORS.stale;
        return COLORS.inFlight;
    }

    //an applied flap is the only thing that ever reaches the game, so it gets the flash
    function flashing(scene) {
        if (flaps.length === 0) return false;
        let since = scene.frame - flaps[flaps.length - 1];
        return since >= 0 && since <= JEV_HUD_FLASH;
    }
    //#endregion

    //#region what jev sees
    // What the last request actually said: the bird where the question put it, the pipe
    // it was about, the numbers it carried in words, and the answer we spent. Nothing
    // here reads the world, it all comes off lastSent, so this is the question and not
    // the now.
    function drawSeen(scene) {
        let sent = scene.lastSent;
        let fields = sent.fields;
        let gap = sent.gap;
        let r = JEV_COLLISION_R;
        let ghostY = sent.predicted.birdY;
        let small = width / 34;

        push(); //the thread from the real bird to where the question put it
            stroke(COLORS.hair);
            strokeWeight(1);
            dashed(true);
            line(BIRD_X, scene.bird.pos.y, BIRD_X, ghostY);
            dashed(false);
        pop();

        push(); //the ghost, an outline: the bird is the only solid red thing on screen
            noFill();
            stroke(COLORS.ghost);
            strokeWeight(1.5);
            ellipse(BIRD_X, ghostY, r * 2, r * 2);

            noStroke();
            fill(COLORS.ghost);
            textFont(JEV_HUD_MONO);
            textSize(small);
            textAlign(RIGHT, CENTER);
            text("+" + sent.leadFrames + "f", BIRD_X - r - 6, ghostY);
        pop();

        if (gap != null) {
            let middle = (gap.top + gap.bottom) / 2;
            let aboveColor = fields.above < 0 ? COLORS.danger : COLORS.line;
            let belowColor = fields.below < 0 ? COLORS.danger : COLORS.line;

            push(); //the gap split at its middle: cool above, warm below, both barely there
                noStroke();
                fill(COLORS.upperHalf);
                rect(gap.x1, gap.top, gap.x2 - gap.x1, middle - gap.top);
                fill(COLORS.lowerHalf);
                rect(gap.x1, middle, gap.x2 - gap.x1, gap.bottom - middle);
            pop();

            push(); //the two clearances, exactly the px the question carried
                strokeWeight(1);
                textFont(JEV_HUD_MONO);
                textSize(small);
                textAlign(RIGHT, CENTER);

                dashed(true);
                stroke(aboveColor);
                line(BIRD_X, ghostY - r, BIRD_X, gap.top);
                stroke(belowColor);
                line(BIRD_X, ghostY + r, BIRD_X, gap.bottom);
                dashed(false);

                noStroke();
                fill(aboveColor);
                text(fields.above + " px", BIRD_X - 5, (ghostY - r + gap.top) / 2);
                fill(belowColor);
                text(fields.below + " px", BIRD_X - 5, (ghostY + r + gap.bottom) / 2);
            pop();

            push(); //the ruler: nose of the ghost to the front of the pipe
                stroke(COLORS.line);
                strokeWeight(1);
                line(BIRD_X + r, ghostY, gap.x1, ghostY);
                line(BIRD_X + r, ghostY - 4, BIRD_X + r, ghostY + 4);
                line(gap.x1, ghostY - 4, gap.x1, ghostY + 4);

                noStroke();
                fill(COLORS.line);
                textFont(JEV_HUD_MONO);
                textSize(small);
                //under the pipe end of the ruler: the decision owns everything above it
                textAlign(RIGHT, TOP);
                text(fields.distance + " px", gap.x1 - 5, ghostY + 3);
            pop();
        }

        //the arrow is the motion, so "level" gets none
        if (fields.motion !== "level") {
            let velocity = sent.predicted.birdVelocity;
            let length = Math.min(JEV_HUD_ARROW_MAX, Math.abs(velocity) * JEV_HUD_ARROW_SCALE);
            let way = velocity < 0 ? -1 : 1;
            let x = BIRD_X - 13;
            let tip = ghostY + way * length;

            push();
                stroke(COLORS.ghost);
                strokeWeight(1.5);
                line(x, ghostY, x, tip);
                line(x, tip, x - 4, tip - way * 5);
                line(x, tip, x + 4, tip - way * 5);
            pop();
        }

        drawDecision(scene, fields, ghostY, small);
    }

    // The answer, beside the ghost and beside the words it was made of. This is the one
    // thing on the canvas that is allowed to shout: it is what the whole loop is for.
    function drawDecision(scene, fields, ghostY, small) {
        let big = width / 22;
        let x = BIRD_X + JEV_COLLISION_R + 8;
        let applied = scene.lastApplied;
        let waiting = scene.waitingForPilot || applied == null || applied.choice == null;

        let label = "waiting for pilot";
        let ink = COLORS.label;
        let probability = null;

        if (!waiting) {
            probability = applied.probabilities != null ? applied.probabilities[applied.choice] : null;
            if (typeof probability !== "number") probability = applied.confidence;
            label = applied.choice + (typeof probability === "number" ? " " + probability.toFixed(2) : "");
            ink = applied.choice === JevQuestions.FLAP ? COLORS.flap : COLORS.wait;
        }

        //the ghost roams the whole lane, so keep the group on the canvas
        let y = clamp(ghostY, big + 8, height - GROUND_HEIGHT - small * 3.6);

        push();
            noStroke();
            fill(ink);
            textFont(JEV_HUD_SANS);
            textStyle(BOLD);
            textSize(waiting ? small * 1.3 : big);
            textAlign(LEFT, BOTTOM);
            text(label, x, y);
            textStyle(NORMAL);

            //a short bar under the word, so the number has a shape as well as a value
            if (typeof probability === "number") {
                let full = width * 0.19;
                fill(COLORS.well);
                rect(x, y + 4, full, 3);
                fill(ink);
                rect(x, y + 4, Math.max(1, full * clamp(probability, 0, 1)), 3);
            }

            //the two words the decision was really made of, quiet underneath it
            fill(COLORS.label);
            textFont(JEV_HUD_SANS);
            textSize(small);
            textAlign(LEFT, TOP);
            text(fields.position, x, y + small + 4);
            text(fields.motion, x, y + small * 2.3 + 4);
        pop();
    }
    //#endregion

    //#region the badge row
    // A ticker, not a panel: values in white monospace, the words beside them in the
    // quiet grey. It is laid out every few frames because it only has to be readable.
    var badgeValue = ["", "", "", "", ""];
    var badgeLabel = [" ms", "f lead", " req/s", "/h", " speed"];
    var badgeX = [0, 0, 0, 0, 0];
    var labelX = [0, 0, 0, 0, 0];
    var badgeReady = false;

    //two samples of the session's token counter are enough for a rate
    var tokenThen = null;
    var costPerHour = null;

    function updateCost(scene) {
        let tokens = scene.client.stats.inputTokens;
        let at = now();

        //a restart keeps the client, a smaller count means a brand new one
        if (tokenThen == null || tokens < tokenThen.tokens) {
            tokenThen = { at: at, tokens: tokens };
            costPerHour = null;
            return;
        }

        let seconds = (at - tokenThen.at) / 1000;
        if (seconds < 4) return;

        costPerHour = (tokens - tokenThen.tokens) / seconds * 3600 * JEV_HUD_INPUT_COST / 1e6;

        //roll the older sample forward so the window stays 4-30 s
        if (seconds > 30) tokenThen = { at: at, tokens: tokens };
    }

    function layoutBadges(scene, small) {
        let stats = scene.client.stats;
        let seconds = Math.max(60, Math.min(JEV_HUD_WINDOW, scene.frame)) / 60;

        badgeValue[0] = String(stats.lastLatencyMs > 0 ? stats.lastLatencyMs : Math.round(scene.leadMs));
        badgeValue[1] = String(scene.leadFrames());
        badgeValue[2] = (sends / seconds).toFixed(1);
        badgeValue[3] = costPerHour != null ? "$" + costPerHour.toFixed(2) : "$-";
        badgeValue[4] = "1/" + JEV_TIME_SCALE;

        let x = 8;
        let space = small * 0.9;

        for (let i = 0; i < badgeValue.length; i++) {
            textFont(JEV_HUD_MONO);
            textSize(small);
            badgeX[i] = x;
            x += textWidth(badgeValue[i]);

            textFont(JEV_HUD_SANS);
            textSize(small);
            labelX[i] = x;
            x += textWidth(badgeLabel[i]) + space;
        }

        badgeReady = true;
    }

    //the row sits under the score, which the scene always draws at a fixed 60
    function drawBadges(scene) {
        let small = width / 34;
        let y = 78;

        updateCost(scene);

        push();
            textAlign(LEFT, TOP);
            //~10 Hz is plenty for a ticker, and the layout costs a textWidth per part
            if (!badgeReady || frameCount % 6 === 0) layoutBadges(scene, small);

            noStroke();
            fill(COLORS.value);
            textFont(JEV_HUD_MONO);
            textSize(small);
            for (let i = 0; i < badgeValue.length; i++) text(badgeValue[i], badgeX[i], y);

            fill(COLORS.label);
            textFont(JEV_HUD_SANS);
            textSize(small);
            for (let j = 0; j < badgeLabel.length; j++) text(badgeLabel[j], labelX[j], y);
        pop();

        return y + small * 1.5 + 5;
    }
    //#endregion

    //#region the pipeline
    // One bar per request from its send to its answer, stacked into lanes so the overlap
    // is the thing you see. Flap ticks run under the band and a death goes straight
    // through it. Nothing here eases: the band scrolls because the frames do.
    function drawTimeline(scene, top) {
        let x0 = 8;
        let x1 = width - 8;
        let h = Math.max(12, width / 28);
        let barsH = h * 0.72;
        let laneH = barsH / JEV_HUD_LANES;
        let tickY = top + barsH + 2;
        let tickH = h - barsH - 2;

        let from = scene.frame - JEV_HUD_WINDOW;
        let scale = (x1 - x0) / JEV_HUD_WINDOW;

        function at(frame) {
            return clamp(x0 + (frame - from) * scale, x0, x1);
        }

        push();
            noStroke();
            fill(COLORS.well);
            rect(x0, top, x1 - x0, h);

            laneEnd.length = JEV_HUD_LANES;
            for (let l = 0; l < JEV_HUD_LANES; l++) laneEnd[l] = -1e9;

            for (let i = 0; i < reqSend.length; i++) {
                let end = reqRecv[i] !== -1 ? reqRecv[i] : scene.frame;

                let lane = JEV_HUD_LANES - 1;
                for (let j = 0; j < JEV_HUD_LANES; j++) {
                    if (laneEnd[j] <= reqSend[i]) {
                        lane = j;
                        break;
                    }
                }
                laneEnd[lane] = end + 1;

                let bx = at(reqSend[i]);
                fill(outcomeColor(reqOutcome[i]));
                rect(bx, top + lane * laneH, Math.max(1.5, at(end) - bx), Math.max(1, laneH - 1));
            }

            fill(COLORS.flap);
            for (let f = 0; f < flaps.length; f++) {
                if (flaps[f] < from) continue;
                rect(at(flaps[f]), tickY, 1.5, tickH);
            }
        pop();

        push();
            stroke(COLORS.value);
            strokeWeight(1);
            for (let d = 0; d < deaths.length; d++) {
                if (deaths[d] < from) continue;
                line(at(deaths[d]), top, at(deaths[d]), top + h);
            }
        pop();

        drawCounters(scene, top + h + 3);
    }

    //applied, superseded, stale, in that order, laid out from the right
    function drawCounters(scene, y) {
        let stats = scene.client.stats;
        let small = width / 34;
        let x = width - 8;

        push();
            noStroke();
            textFont(JEV_HUD_MONO);
            textSize(small);
            textAlign(RIGHT, TOP);

            x = counter(stats.stale, COLORS.stale, x, y, small);
            x = counter(stats.superseded, COLORS.superseded, x, y, small);
            counter(stats.applied, COLORS.applied, x, y, small);
        pop();
    }

    function counter(value, ink, x, y, small) {
        let label = String(value);
        fill(ink);
        text(label, x, y);
        return x - textWidth(label) - small * 0.8;
    }
    //#endregion

    //#region the decision flow
    // The ground band earns its keep: the four boxes the loop actually is, packets
    // crawling from the snapshot to Jev for exactly as long as the round trip really
    // takes, the two probabilities that came back, and the edge that lights when a
    // FLAP reaches the game.
    var FLOW_NODES = ["Snapshot", "Question", "Jev", "Action"];
    var nodeX = [0, 0, 0, 0];

    function drawFlow(scene) {
        let bandTop = height - GROUND_HEIGHT;
        let x0 = JEV_HUD_LEFT_CLEAR;
        let x1 = width - 8;
        let edge = Math.max(14, width / 26);
        let gap = Math.max(4, width / 62);
        let boxW = (x1 - x0 - edge - gap * 3) / 4;
        if (boxW < 24) return;

        let small = width / 34;
        let boxH = Math.max(12, GROUND_HEIGHT * 0.32);
        let boxY = bandTop + 4;
        let midY = boxY + boxH / 2;
        let flash = flashing(scene);

        push();
            textFont(JEV_HUD_SANS);
            textSize(small * 0.85);
            textAlign(CENTER, CENTER);

            for (let i = 0; i < 4; i++) {
                let x = x0 + i * (boxW + gap);
                nodeX[i] = x + boxW / 2;
                let hot = i === 3 && flash;

                noStroke();
                fill(COLORS.box);
                rect(x, boxY, boxW, boxH);

                noFill();
                stroke(hot ? COLORS.flap : COLORS.hair);
                strokeWeight(1);
                rect(x, boxY, boxW, boxH);

                noStroke();
                fill(hot ? COLORS.flap : COLORS.label);
                text(FLOW_NODES[i], nodeX[i], midY);

                if (i > 0) arrow(x - gap - 1, midY, x - 1, COLORS.hair, 1);
            }

            //the last edge goes out to the game, and it is the only thing that flashes
            arrow(x0 + 3 * (boxW + gap) + boxW + 1, midY, x1, flash ? COLORS.flap : COLORS.hair, flash ? 2 : 1);
        pop();

        drawPackets(scene, midY);
        drawBars(scene, x0 + 3 * (boxW + gap), boxW, boxY + boxH + 3);
    }

    //every request still in the air, as far along as the wall clock says it is
    function drawPackets(scene, midY) {
        let stamps = scene.sendStamps;
        if (stamps.length === 0) return;

        let at = now();
        let duration = Math.max(60, scene.leadMs);

        push();
            noStroke();
            for (let i = 0; i < stamps.length; i++) {
                let p = clamp((at - stamps[i].at) / duration, 0, 1);
                COLORS.packet.setAlpha(90 + 130 * (1 - p));
                fill(COLORS.packet);
                ellipse(nodeX[0] + (nodeX[2] - nodeX[0]) * p, midY, 5, 5);
            }
        pop();
    }

    //the two probabilities the last answer came back with, under the action box
    function drawBars(scene, x, boxW, y) {
        let answer = scene.lastAnswer;
        let high = Math.max(3, GROUND_HEIGHT * 0.07);

        push();
            noStroke();
            bar(x, y, boxW, high, answer, JevQuestions.FLAP, COLORS.flap);
            bar(x, y + high + 2, boxW, high, answer, JevQuestions.WAIT, COLORS.wait);
        pop();
    }

    function bar(x, y, full, high, answer, option, ink) {
        fill(COLORS.well);
        rect(x, y, full, high);

        if (answer == null) return;

        let value = answer.probabilities != null ? answer.probabilities[option] : null;
        if (typeof value !== "number" && typeof answer.confidence === "number") {
            //the question is binary, so the other option gets the rest of it
            value = answer.choice === option ? answer.confidence : 1 - answer.confidence;
        }
        if (typeof value !== "number") return;

        fill(ink);
        rect(x, y, Math.max(1, full * clamp(value, 0, 1)), high);
    }
    //#endregion

    //a line with a head on it; the flow only ever points right
    function arrow(x1, y, x2, ink, weight) {
        stroke(ink);
        strokeWeight(weight);
        line(x1, y, x2, y);
        line(x2, y, x2 - 4, y - 3);
        line(x2, y, x2 - 4, y + 3);
        noStroke();
    }

    //the tap is the only control a phone has, so say so once and then stop
    function drawHint(scene) {
        if (now() - scene.startedAtMs > JEV_HUD_HINT_MS) return;

        push();
            noStroke();
            fill(COLORS.label);
            textFont(JEV_HUD_SANS);
            textSize(width / 34);
            textAlign(RIGHT, TOP);
            text("tap: hud", width - 8, 8);
        pop();
    }

    // The one call the scene makes, after the game and before the overlays that stop it.
    // Level 0 paints nothing at all.
    function draw(scene) {
        if (scene.hudLevel <= 0) return;
        if (scene.bird == null || !scene.bird.live) return;

        ensureColors();

        if (scene.lastSent != null) drawSeen(scene);
        drawHint(scene);

        if (scene.hudLevel < 2) return;

        readTail(scene);
        drawTimeline(scene, drawBadges(scene));
        drawFlow(scene);
    }

    return {
        draw: draw,
        drawSeen: drawSeen,
        drawBadges: drawBadges,
        drawTimeline: drawTimeline,
        drawFlow: drawFlow
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevHud = JevHud;
