// Pure scene translator for the Jev pilot, v2.
// Turns raw numbers from the game loop into the snapshot Jev decides on.
// No p5 globals, no DOM, no width/height. Safe to require() from Node.
//
// v2 follows the shape that has been shown to fly (words that mirror the answer
// options, plain numbers beside them) and adds predict(): the scene as it will be
// when the answer lands, assuming the bird is left alone. Code predicts where the
// world will be; Jev decides what to do there.
var JevTranslator = (function () {
    var VERSION = "2.1.0";

    // physics, copied from constants.js / bird.js / pipe.js so Node can run it too
    var GRAVITY = 0.4;
    var PIPE_SCROLL = 2;

    // v is px per game frame, negative is upward on screen
    function motion(v) {
        if (v < -1) return "rising";
        if (v <= 1) return "level";
        if (v <= 4) return "falling";
        return "falling fast";
    }

    // above/below are clearances in px between the bird's edge and the gap edges
    function position(above, below) {
        if (above < 0) return "above the gap";
        if (below < 0) return "below the gap";
        if (above < below) return "inside the gap, upper half";
        return "inside the gap, lower half";
    }

    // Advance the world by `frames` draw frames with the bird left alone.
    // dt is the physics step per draw frame (1 at normal speed, 1/4 at quarter speed).
    function predict(input, frames, dt) {
        dt = dt || 1;
        var y = input.birdY;
        var v = input.birdVelocity;
        var groundY = input.groundY;
        var n = Math.max(0, Math.round(frames));
        for (var i = 0; i < n; i++) {
            if (y < groundY) {
                y += v * dt;
                v += GRAVITY * dt;
            } else {
                y = groundY;
            }
        }
        var shift = PIPE_SCROLL * dt * n;
        return { birdY: y, birdVelocity: v, pipeShift: shift };
    }

    /**
     * input: { birdX, birdY, birdVelocity, birdRadius, groundY,
     *          pipes: [{x1, x2, gapTop, gapBottom}, ...] sorted left to right }
     * leadFrames: how far ahead to describe (0 = now); dt: physics step per frame
     * returns { state, fields, predicted } or null when no pipe is ahead
     */
    function describeScene(input, leadFrames, dt) {
        var p = predict(input, leadFrames || 0, dt);
        var r = input.birdRadius;
        var front = input.birdX + r;

        // same criterion the scenes use: the first pipe whose trailing edge is still ahead
        var pipe = null;
        for (var i = 0; i < input.pipes.length; i++) {
            var c = input.pipes[i];
            if (c.x2 - p.pipeShift > input.birdX - r) { pipe = c; break; }
        }
        if (pipe == null) return null;

        var y = Math.round(p.birdY);
        var gapTop = Math.round(pipe.gapTop);
        var gapBottom = Math.round(pipe.gapBottom);
        var above = (y - r) - gapTop;
        var below = gapBottom - (y + r);
        var distance = Math.max(0, Math.round(pipe.x1 - p.pipeShift - front));

        var fields = {
            position: position(above, below),
            motion: motion(p.birdVelocity),
            above: above,
            below: below,
            distance: distance
        };

        var state = {
            bird: {
                y: y,
                velocity_y: Math.round(p.birdVelocity * 10) / 10,
                position: fields.position,
                motion: fields.motion,
                clearance_above_bird_to_gap_top: above,
                clearance_below_bird_to_gap_bottom: below
            },
            next_pipe: {
                distance_x: distance,
                gap_top_y: gapTop,
                gap_bottom_y: gapBottom
            },
            y_axis: "y grows downward; smaller y is higher"
        };

        return { state: state, fields: fields, predicted: p };
    }

    // Two (or more) snapshots of the same flight at different leads, side by side in
    // one state object, so one request can carry a question per horizon. Keys are the
    // horizon names the questions refer to ("now" is the expected arrival, "later" a
    // little after it). Returns null when no pipe is ahead at the first horizon.
    function describeHorizons(input, leads, dt) {
        var state = {};
        var snapshots = [];
        for (var i = 0; i < leads.length; i++) {
            var d = describeScene(input, leads[i].frames, dt);
            if (d == null) return null;
            state[leads[i].key] = d.state;
            snapshots.push({ key: leads[i].key, frames: leads[i].frames, fields: d.fields, state: d.state });
        }
        return { state: state, snapshots: snapshots };
    }

    // The premise a decision rests on. If these words still hold when the answer is
    // applied, the answer is still about the world the bird is in. Above / below the
    // gap do not depend on motion in the criteria, the two halves do.
    function premiseHolds(askedFields, currentFields) {
        if (askedFields.position !== currentFields.position) return false;
        if (askedFields.position === "above the gap" || askedFields.position === "below the gap") return true;
        return askedFields.motion === currentFields.motion;
    }

    return {
        VERSION: VERSION,
        describeScene: describeScene,
        describeHorizons: describeHorizons,
        premiseHolds: premiseHolds,
        predict: predict,
        motion: motion,
        position: position
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevTranslator = JevTranslator;
if (typeof module !== "undefined" && module.exports) module.exports = JevTranslator;
