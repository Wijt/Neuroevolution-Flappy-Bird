// Question definitions for the Jev pilot.
// build() returns a fresh deep copy every call so nothing can mutate shared state.
var JevQuestions = (function () {
    var FLAP_THRESHOLD = 0.5;
    var IDS = ["flap", "read", "danger"];

    function build() {
        return {
            flap: {
                type: "noul",
                instructions: "Given the described situation, should the bird flap right now?",
                criteria: {
                    true: "flapping now leads to a safer position in the gap",
                    false: "waiting is safer, or flapping risks the top pipe or the ceiling"
                }
            },
            read: {
                type: "choice",
                instructions: "Which best describes the bird's situation?",
                criteria: {
                    too_high: "the bird sits above the opening and should come down",
                    aligned: "the bird is lined up with the opening",
                    too_low: "the bird sits below the opening and should climb",
                    entering_pipe_misaligned: "the bird is at the pipes but not lined up with the opening",
                    ground_danger: "the ground is close below and the bird is about to hit it",
                    ceiling_danger: "the ceiling is close above and the bird is about to hit it"
                }
            },
            danger: {
                type: "score",
                instructions: "How close is the bird to losing?",
                criteria: [
                    "comfortably safe",
                    "needs a correction soon",
                    "one wrong move from a collision",
                    "collision nearly unavoidable"
                ]
            }
        };
    }

    return {
        FLAP_THRESHOLD: FLAP_THRESHOLD,
        IDS: IDS,
        build: build
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevQuestions = JevQuestions;
if (typeof module !== "undefined" && module.exports) module.exports = JevQuestions;
