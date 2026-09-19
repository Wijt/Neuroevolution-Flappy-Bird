(function (root) {
const physics = typeof module !== 'undefined' && module.exports ? require('./jev-physics') : root.JevPhysics;
const ACTION_FRAMES = 6;
const question = {
    type: 'choice',
    instructions: 'Choose the next single action for Flappy Bird using state.analysis, which contains exact physics forecasts. ' +
        'Y increases DOWN: smaller y is higher; negative velocity means rising. Flap resets velocity to -6, it is NOT a sustained button press. ' +
        'Prefer an action safeUntilNextDecision=true. Compare firstCollisionTick and the gap center. ' +
        'Coast while already rising or above the desired height; repeated flaps can hit the ceiling. ' +
        'Flap when descending and additional lift is needed to reach the gap or avoid the ground. ' +
        'When the pipe is far away, preserve altitude without climbing to the ceiling. ' +
        'The 30-tick forecasts assume no later flap; do not treat a distant coast collision as inevitable, since you can decide again after 6 ticks.',
    criteria: {
        flap: 'One upward impulse now, then no flap for the next 6 ticks. Choose only when lift is needed and its forecast is safe.',
        coast: 'No impulse for 6 ticks. Preserve existing upward momentum or descend toward the gap; another decision follows.'
    }
};

function buildRequest(state, model = 'jev-latest') {
    return { model, state: { ...state, analysis: physics.evidence(state) }, questions: { action: question } };
}
const api = { ACTION_FRAMES, buildRequest };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.JevContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
