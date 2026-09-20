// Question definitions for the Jev pilot, v2: one binary choice per snapshot.
// build() returns a fresh deep copy every call so nothing can mutate shared state.
// The option text uses the same words as the snapshot's `position` and `motion`,
// so Jev matches rather than reasons. The game acts on `decision` only.
var JevQuestions = (function () {
    var IDS = ["decision"];
    var FLAP = "FLAP";
    var WAIT = "WAIT";

    function build() {
        return {
            decision: {
                type: "choice",
                instructions: "What should the bird do right now to pass safely through the gap of the next pipe?",
                criteria: {
                    FLAP: "the bird is below the gap, or is in the lower half of the gap and not rising",
                    WAIT: "the bird is above the gap (even when falling fast), or is in the upper half of the gap, or is rising inside the gap"
                }
            }
        };
    }

    return {
        IDS: IDS,
        FLAP: FLAP,
        WAIT: WAIT,
        build: build
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevQuestions = JevQuestions;
if (typeof module !== "undefined" && module.exports) module.exports = JevQuestions;
