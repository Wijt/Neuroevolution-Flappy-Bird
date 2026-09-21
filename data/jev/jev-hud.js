// The Jev overlay: the one sensory layer, drawn straight on the canvas.
// No DOM and no libraries. The scene hands us itself once per draw and we paint;
// nothing in here changes the world, so the overlay can be switched off without
// the flight noticing.
//
// It draws the question and nothing else: the bird where the request put it, the
// pipe the request was about, the two clearances it carried in px, and the answer
// that came back. All the telemetry moved to the panel, so this is an interpretation
// of the scene and never a dashboard.
//
// Nothing is allowed to sit on the bird. The ghost's text is one stacked block to
// the right of it, the clearances are labelled to the left of their line, and the
// ruler is labelled above itself. V toggles the whole thing.
//#region palette
//the game's own colours plus the one cool tone the panel also uses
const JEV_HUD_COOL = "#4f8a8b";

//the quiet grey the labels are written in
const JEV_HUD_LABEL = "#8fa6c8";
//#endregion

//#region looks
//numbers are monospace, words are not
const JEV_HUD_MONO = "ui-monospace, Consolas, Menlo, monospace";
const JEV_HUD_SANS = "sans-serif";

//the text block starts clear of the bird, not clear of the collision circle
const JEV_HUD_CLEAR = 10;
//#endregion

var JevHud = (function () {
    function clamp(n, lo, hi) {
        return n < lo ? lo : (n > hi ? hi : n);
    }

    //#region the palette, built once
    // color() allocates and the overlay draws every frame, so the whole palette is
    // made on the first draw and kept. It cannot be made up front, p5 is not running yet.
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
            flap: color(BIRD_COLOR),
            wait: color(JEV_HUD_COOL),
            well: color(0, 0, 0, 70)
        };
    }

    //a hairline that says "drawn by the pilot", not "part of the world"
    function dashed(on) {
        if (typeof drawingContext === "undefined" || drawingContext.setLineDash == null) return;
        drawingContext.setLineDash(on ? [4, 4] : []);
    }
    //#endregion

    //#region what jev sees
    // What the last request actually said: the bird where the question put it, the pipe
    // it was about and the numbers it carried in words. Nothing here reads the world,
    // it all comes off lastSent, so this is the question and not the now.
    function drawSeen(scene) {
        let sent = scene.lastSent;
        let fields = sent.fields;
        let gap = sent.gap;
        let r = JEV_COLLISION_R;
        let ghostY = sent.predicted.birdY;
        //never below 12 px, the phone would make the numbers unreadable otherwise
        let small = Math.max(12, width / 30);

        //the labels sit outside the bird, whichever way they go
        let leftEdge = BIRD_X - BIRD_R - 6;

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
                //a label sits halfway along its line; when the bird is outside the gap the
                //line is inside the ghost, so the label moves just past the gap edge instead
                fill(aboveColor);
                text(fields.above + " px", leftEdge, fields.above >= 0 ? (ghostY - r + gap.top) / 2 : gap.top - 8);
                fill(belowColor);
                text(fields.below + " px", leftEdge, fields.below >= 0 ? (ghostY + r + gap.bottom) / 2 : gap.bottom + 8);
            pop();

            //the ruler only when there is a distance left to show; at the pipe it has no length
            if (fields.distance > 20) {
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
                    //above its own line, so the decision block underneath stays clear
                    textAlign(RIGHT, BOTTOM);
                    text(fields.distance + " px", gap.x1 - 4, ghostY - 4);
                pop();
            }
        }

        //the panel says the same thing bigger; when it is open the canvas keeps just the ghost
        if (typeof JevPanel === "undefined" || !JevPanel.isOpen()) drawDecision(scene, fields, ghostY, small);
    }

    // The answer, in one stacked block beside the ghost: the word it chose, a bar for
    // the number, the two phrases it was really made of, and how far ahead the question
    // was asked. The block goes under the ghost, or over it when the ground is close,
    // and it always starts clear of the bird.
    function drawDecision(scene, fields, ghostY, small) {
        let big = width / 22;
        let x = BIRD_X + BIRD_R + JEV_HUD_CLEAR;
        let applied = scene.lastApplied;
        let waiting = scene.waitingForPilot || applied == null || applied.choice == null;

        let word = "Waiting for pilot";
        let ink = COLORS.label;
        let probability = null;

        if (!waiting) {
            probability = applied.probabilities != null ? applied.probabilities[applied.choice] : null;
            if (typeof probability !== "number") probability = applied.confidence;

            //sentence case: the criteria shout in capitals, the overlay does not
            word = applied.choice.charAt(0) + applied.choice.slice(1).toLowerCase();
            if (typeof probability === "number") word += " " + probability.toFixed(2);

            ink = applied.choice === JevQuestions.FLAP ? COLORS.flap : COLORS.wait;
        }

        let head = waiting ? small * 1.3 : big;
        let bar = typeof probability === "number" ? 9 : 0;
        let high = head + bar + small * 2.7 + 6;

        //under the ghost by default, over it when there is no room left below
        let top = ghostY + BIRD_R + 8;
        if (top + high > height - GROUND_HEIGHT - 4) top = ghostY - BIRD_R - 8 - high;
        top = clamp(top, 8, Math.max(8, height - GROUND_HEIGHT - high - 4));

        push();
            noStroke();
            fill(ink);
            textFont(JEV_HUD_SANS);
            textStyle(BOLD);
            textSize(head);
            textAlign(LEFT, TOP);
            text(word, x, top);
            textStyle(NORMAL);

            //a short bar under the word, so the number has a shape as well as a value
            if (bar > 0) {
                let full = width * 0.19;
                fill(COLORS.well);
                rect(x, top + head + 3, full, 3);
                fill(ink);
                rect(x, top + head + 3, Math.max(1, full * clamp(probability, 0, 1)), 3);
            }

            //the two words the decision was really made of, quiet underneath it
            fill(COLORS.label);
            textFont(JEV_HUD_SANS);
            textSize(small);
            text(fields.position + " · " + fields.motion, x, top + head + bar + 3);

            //how far ahead the question was asked, in the seconds it really was
            textFont(JEV_HUD_MONO);
            text("in " + leadSeconds(scene).toFixed(2) + " s", x, top + head + bar + small * 1.4 + 3);
        pop();
    }

    //the lead is spent in frames and measured in ms; this says it back in seconds
    function leadSeconds(scene) {
        let frameMs = scene.frameMs || JEV_FRAME_MS;
        return scene.lastSent.leadFrames * frameMs / 1000;
    }
    //#endregion

    // The one call the scene makes, after the game and before the overlays that stop it.
    function draw(scene) {
        if (!scene.overlay) return;
        if (scene.bird == null || !scene.bird.live) return;
        if (scene.lastSent == null) return;

        ensureColors();

        drawSeen(scene);
    }

    return {
        draw: draw,
        drawSeen: drawSeen
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevHud = JevHud;
