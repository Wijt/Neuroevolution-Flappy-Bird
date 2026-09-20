// Question definitions for the Jev pilot, v2: one binary choice per snapshot.
// build() returns a fresh deep copy every call so nothing can mutate shared state.
// The option text uses the same words as the snapshot's `position` and `motion`,
// so Jev matches rather than reasons.
var JevQuestions = (function () {
    var FLAP = "FLAP";
    var WAIT = "WAIT";
    var HORIZONS = ["now", "later"];

    var INSTRUCTIONS = "What should the bird do right now to pass safely through the gap of the next pipe?";
    var CRITERIA = {
        FLAP: "the bird is below the gap, or is in the lower half of the gap and not rising",
        WAIT: "the bird is above the gap (even when falling fast), or is in the upper half of the gap, or is rising inside the gap"
    };

    // build() -> one question `decision` about a single snapshot state.
    // build(["now", "later"]) -> one question per horizon, each told which part of the
    // state to judge; the state then has one snapshot under each of those keys.
    function build(keys) {
        var questions = {};
        if (!keys || keys.length === 0) {
            questions.decision = {
                type: "choice",
                instructions: INSTRUCTIONS,
                criteria: JSON.parse(JSON.stringify(CRITERIA))
            };
            return questions;
        }
        for (var i = 0; i < keys.length; i++) {
            questions[keys[i]] = {
                type: "choice",
                instructions: INSTRUCTIONS + " Judge only the snapshot under `" + keys[i] + "`; ignore the other snapshots.",
                criteria: JSON.parse(JSON.stringify(CRITERIA))
            };
        }
        return questions;
    }

    return {
        IDS: ["decision"],
        FLAP: FLAP,
        WAIT: WAIT,
        HORIZONS: HORIZONS,
        build: build
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevQuestions = JevQuestions;
if (typeof module !== "undefined" && module.exports) module.exports = JevQuestions;
