// Pure scene translator for the Jev pilot.
// Turns raw numbers from the game loop into a small, fixed vocabulary.
// No p5 globals, no DOM, no width/height. Safe to require() from Node.
var JevTranslator = (function () {
    var VERSION = "1.0.0";

    var RULES_TEXT = "The bird flies right at constant speed and cannot slow down or turn. Gravity pulls it down constantly. A flap gives one short upward hop, after which it falls again; flapping repeatedly stacks hops upward. Pipes arrive from the right; each has a top and bottom pipe with an opening between them. Touching a pipe, the ground or the ceiling ends the flight.";

    // v is px/frame, negative is upward on screen.
    function verticalMotion(v) {
        if (v <= -4) return "shooting upward from a flap";
        if (v <= -1) return "still rising";
        if (v < 1) return "hanging at the top of its hop";
        if (v < 3) return "starting to fall";
        if (v < 6) return "falling";
        return "dropping fast";
    }

    // offset = birdY - gapCenter, positive means the bird is below the gap centre.
    function placeInGap(offset) {
        if (Math.abs(offset) <= 15) return "in the middle of the gap";
        if (offset < -50) return "level with the top pipe";
        if (offset <= -35) return "close to the top pipe edge";
        if (offset < 0) return "a little above the middle";
        if (offset > 50) return "level with the bottom pipe";
        if (offset >= 35) return "close to the bottom pipe edge";
        return "a little below the middle";
    }

    function lastFlap(frames) {
        if (frames < 6) return "flapped just now";
        if (frames <= 20) return "flapped a moment ago";
        return "has not flapped recently";
    }

    function surroundings(info) {
        var birdY = info.birdY;
        var birdRadius = info.birdRadius;
        var groundY = info.groundY;
        if (groundY - (birdY + birdRadius) < 60) return "the ground is close below";
        if (birdY - birdRadius < 60) return "the ceiling is close above";
        return "open sky above and below";
    }

    function pipeDistance(info) {
        var birdX = info.birdX;
        var birdRadius = info.birdRadius;
        var x1 = info.x1;
        var x2 = info.x2;
        if (birdX >= x1 && birdX <= x2) return "between the pipes right now";
        var d = x1 - (birdX + birdRadius);
        if (d < 40) return "right in front of the bird";
        if (d < 100) return "close ahead";
        if (d < 200) return "some distance ahead";
        return "far ahead";
    }

    // delta = followingGapCenter - currentGapCenter; screen y grows downward, so a
    // negative delta means the next gap sits higher on the screen.
    function followingGap(delta) {
        if (Math.abs(delta) <= 20) return "about the same height";
        if (delta < -60) return "much higher";
        if (delta < 0) return "a little higher";
        if (delta > 60) return "much lower";
        return "a little lower";
    }

    function describeScene(input) {
        var nextPipe = input.nextPipe;
        var followingPipe = input.followingPipe;

        var fields = {
            vertical_motion: verticalMotion(input.birdVelocity),
            place_in_gap: placeInGap(input.birdY - nextPipe.gapCenter),
            last_flap: lastFlap(input.framesSinceFlap),
            surroundings: surroundings({
                birdY: input.birdY,
                birdRadius: input.birdRadius,
                groundY: input.groundY
            }),
            distance: pipeDistance({
                birdX: input.birdX,
                birdRadius: input.birdRadius,
                x1: nextPipe.x1,
                x2: nextPipe.x2
            }),
            following_gap: null
        };

        var betweenPipes = fields.distance === "between the pipes right now";
        if (betweenPipes && followingPipe) {
            fields.following_gap = followingGap(followingPipe.gapCenter - nextPipe.gapCenter);
        }

        var state = {
            rules: RULES_TEXT,
            bird: {
                vertical_motion: fields.vertical_motion,
                place_in_gap: fields.place_in_gap,
                last_flap: fields.last_flap,
                surroundings: fields.surroundings
            },
            pipe_ahead: {
                distance: fields.distance
            }
        };
        if (fields.following_gap !== null) {
            state.following_gap = fields.following_gap;
        }

        var prose = RULES_TEXT +
            " Right now the bird is " + fields.vertical_motion +
            ", it is " + fields.place_in_gap +
            ", it " + fields.last_flap +
            ", and " + fields.surroundings +
            (betweenPipes
                ? ". The bird is between the pipes right now."
                : ". The next pipe is " + fields.distance + ".");
        if (fields.following_gap !== null) {
            prose += " The gap after this one is " + fields.following_gap + ".";
        }

        return { state: state, prose: prose, fields: fields };
    }

    return {
        VERSION: VERSION,
        RULES_TEXT: RULES_TEXT,
        describeScene: describeScene,
        verticalMotion: verticalMotion,
        placeInGap: placeInGap,
        lastFlap: lastFlap,
        surroundings: surroundings,
        pipeDistance: pipeDistance,
        followingGap: followingGap
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevTranslator = JevTranslator;
if (typeof module !== "undefined" && module.exports) module.exports = JevTranslator;
