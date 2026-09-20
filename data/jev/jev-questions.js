// Question definitions for the Jev pilot.
// build() returns a fresh deep copy every call so nothing can mutate shared state.
// The game acts on `maneuver` only; `read` and `danger` feed the side panel.
var JevQuestions = (function () {
    // how many flaps each maneuver turns into, and how far apart the flaps land
    var HOPS = { let_it_fall: 0, one_hop: 1, two_hops: 2, climb_hard: 3 };
    var HOP_SPACING_FRAMES = 8;
    var IDS = ["maneuver", "read", "danger"];

    function build() {
        return {
            maneuver: {
                type: "choice",
                instructions: "For the next short stretch of flight, which maneuver should the bird make? Flapping is the only way up; not flapping is the only way down.",
                criteria: {
                    let_it_fall: "descend: make no flap and let gravity bring the bird down; the choice when the bird is at or above the middle of the opening, already rising, or close to the ceiling",
                    one_hop: "one flap, lifting the bird by about one hop; the choice when the bird is a little below the middle and falling, or about one hop below the middle, or in the middle of the opening and falling with the pipe right in front of the bird or between the pipes",
                    two_hops: "two flaps in quick succession, lifting the bird by about two hops; the choice when the bird is about two hops below the opening",
                    climb_hard: "three flaps in quick succession, lifting the bird by about three hops; the choice when the bird is several hops below the opening or close to the ground"
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
        HOPS: HOPS,
        HOP_SPACING_FRAMES: HOP_SPACING_FRAMES,
        IDS: IDS,
        build: build
    };
})();

if (typeof globalThis !== "undefined") globalThis.JevQuestions = JevQuestions;
if (typeof module !== "undefined" && module.exports) module.exports = JevQuestions;
