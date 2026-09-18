const { test } = require('node:test');
const assert = require('node:assert/strict');
const JevContract = require('../data/jev-contract');
const JevPhysics = require('../data/jev-physics');

function makeState() {
    return {
        bird: { x: 100, y: 300.44, velocity: 2.3333, radius: 15 },
        world: { width: 450, groundY: 750 },
        physics: { gravity: 0.4, jumpPower: 6, pipeSpeed: 2 },
        pipes: [
            { left: 400, right: 450, gapTop: 260, gapBottom: 385 },
            { left: 650, right: 700, gapTop: 337.5, gapBottom: 462.5 }
        ]
    };
}

test('JevContract.PLANS matches JevPhysics.PLANS', () => {
    assert.deepEqual(JevContract.PLANS, JevPhysics.PLANS);
});

test('buildRequest produces the documented shape', () => {
    const request = JevContract.buildRequest(makeState());
    assert.equal(request.model, 'jev-latest');
    assert.equal(request.questions.plan.type, 'choice');
    assert.deepEqual(Object.keys(request.questions.plan.criteria).sort(), [...JevPhysics.PLANS].sort());
    assert.equal(typeof request.questions.plan.instructions, 'string');

    const state = request.state;
    assert.equal(state.windowTicks, JevPhysics.HORIZON);
    assert.equal(state.bird.motion, 'falling');
    assert.equal(state.bird.collisionRadius, 15);
    assert.ok(state.followingGap);
    assert.deepEqual(Object.keys(state.plans).sort(), [...JevPhysics.PLANS].sort());
    // no raw trajectories leak into the JevState sent to the model
    assert.equal(JSON.stringify(state).includes('trajectory'), false);
    // numbers rounded to 1 decimal
    assert.equal(state.bird.y, 300.4);
    assert.equal(state.bird.velocity, 2.3);
    for (const plan of JevPhysics.PLANS) {
        const p = state.plans[plan];
        for (const field of ['endY', 'endVelocity', 'offsetFromGapCenterAtEnd', 'minClearancePx']) {
            const v = p[field];
            assert.ok(v === null || Math.round(v * 10) === v * 10, `${field} not rounded to 1 decimal: ${v}`);
        }
        assert.equal(typeof p.collisionWithinWindow, 'string');
        assert.equal(typeof p.ifCoastingAfterWindow.collision, 'string');
        assert.equal(typeof p.ifCoastingAfterWindow.passesGap, 'boolean');
    }
});

test('buildRequest omits followingGap when there is only one pipe', () => {
    const state = makeState();
    state.pipes = [state.pipes[0]];
    const request = JevContract.buildRequest(state);
    assert.equal(request.state.followingGap, undefined);
});

test('buildRequest custom model is forwarded', () => {
    const request = JevContract.buildRequest(makeState(), 'jev-custom');
    assert.equal(request.model, 'jev-custom');
});

function validAnswer(overrides = {}) {
    return {
        model: 'jev-latest',
        usage: { input_tokens: 500, output_tokens: 10 },
        answers: {
            plan: {
                type: 'choice',
                choice: 'flap_now',
                probabilities: { flap_now: 0.7, flap_at_4: 0.1, flap_at_8: 0.1, no_flap: 0.1 },
                confidence: 0.85,
                ...overrides
            }
        }
    };
}

test('parseResponse accepts a valid answer', () => {
    const result = JevContract.parseResponse(validAnswer());
    assert.equal(result.plan, 'flap_now');
    assert.equal(result.confidence, 0.85);
    assert.deepEqual(result.probabilities, { flap_now: 0.7, flap_at_4: 0.1, flap_at_8: 0.1, no_flap: 0.1 });
    assert.equal(result.model, 'jev-latest');
    assert.deepEqual(result.usage, { input_tokens: 500, output_tokens: 10 });
});

test('parseResponse defaults usage when missing', () => {
    const data = validAnswer();
    delete data.usage;
    const result = JevContract.parseResponse(data);
    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});

test('parseResponse rejects a plan not in PLANS', () => {
    assert.throws(() => JevContract.parseResponse(validAnswer({ choice: 'flap_forever' })), /Invalid Jev response/);
});

test('parseResponse rejects missing or out-of-range probabilities', () => {
    const data = validAnswer();
    data.answers.plan.probabilities = { flap_now: 0.7, flap_at_4: 0.1, flap_at_8: 0.1 };
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
    const data2 = validAnswer();
    data2.answers.plan.probabilities.flap_now = 1.5;
    assert.throws(() => JevContract.parseResponse(data2), /Invalid Jev response/);
});

test('parseResponse rejects probabilities that do not sum to ~1', () => {
    const data = validAnswer();
    data.answers.plan.probabilities = { flap_now: 0.5, flap_at_4: 0.5, flap_at_8: 0.5, no_flap: 0.5 };
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
});

test('parseResponse tolerates a small rounding slack in probabilities', () => {
    const data = validAnswer();
    data.answers.plan.probabilities = { flap_now: 0.71, flap_at_4: 0.1, flap_at_8: 0.1, no_flap: 0.1 };
    assert.doesNotThrow(() => JevContract.parseResponse(data));
});

test('parseResponse rejects confidence out of [0,1]', () => {
    assert.throws(() => JevContract.parseResponse(validAnswer({ confidence: 1.2 })), /Invalid Jev response/);
});

test('parseResponse rejects a non-choice answer type', () => {
    assert.throws(() => JevContract.parseResponse(validAnswer({ type: 'text' })), /Invalid Jev response/);
});

test('parseResponse rejects a missing answer', () => {
    assert.throws(() => JevContract.parseResponse({ answers: {} }), /Invalid Jev response/);
    assert.throws(() => JevContract.parseResponse({}), /Invalid Jev response/);
});
