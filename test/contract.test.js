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

test('buildRequest produces the plain-language shape', () => {
    const request = JevContract.buildRequest(makeState());
    assert.equal(request.model, 'jev-latest');
    assert.equal(request.questions.plan.type, 'choice');
    assert.deepEqual(Object.keys(request.questions.plan.criteria).sort(), [...JevPhysics.PLANS].sort());
    assert.equal(typeof request.questions.plan.instructions, 'string');

    const state = request.state;
    assert.deepEqual(Object.keys(state), ['game', 'now', 'rays', 'options']);
    assert.match(state.now, /^You are falling\. The hole is BELOW you by \d+ px\./);
    assert.match(state.now, /The hole after that is \d+ px lower\./);
    assert.deepEqual(Object.keys(state.rays), ['straight ahead', 'ahead and up', 'ahead and down']);
    assert.equal(state.rays['ahead and down'], 'the bottom pipe');
    assert.equal(state.rays['straight ahead'], 'the hole - it goes through');
    assert.deepEqual(Object.keys(state.options).sort(), [...JevPhysics.PLANS].sort());
    for (const plan of JevPhysics.PLANS) {
        assert.match(state.options[plan], /^(Safe: .*\.|CRASH into .*\.)$/);
    }
    // no tick jargon reaches the model, and the request stays compact
    const text = JSON.stringify(request);
    assert.equal(/tick/i.test(text), false);
    assert.ok(text.length < 1700, `request too long: ${text.length} chars`);
});

test('a fatal option is described as a crash and a far pipe as far away', () => {
    const state = makeState();
    state.bird.y = 740; state.bird.velocity = 5; // about to hit the ground
    const st = JevContract.buildRequest(state).state;
    assert.match(st.options.no_flap, /^CRASH into the ground\.$/);
    assert.equal(st.rays['ahead and down'], 'the ground');
    state.bird.y = 300; state.bird.velocity = 0;
    state.pipes = [{ left: 1000, right: 1050, gapTop: 260, gapBottom: 385 }];
    const st2 = JevContract.buildRequest(state).state;
    assert.match(st2.now, /The pipe is far \(about \d+(\.\d)? s away\)\.$/);
});

test('buildRequest omits the following hole when there is only one pipe', () => {
    const state = makeState();
    state.pipes = [state.pipes[0]];
    const request = JevContract.buildRequest(state);
    assert.equal(/hole after that/.test(request.state.now), false);
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
                probabilities: { flap_now: 0.7, flap_at_8: 0.1, flap_at_16: 0.1, double_flap: 0, triple_flap: 0, no_flap: 0.1 },
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
    assert.deepEqual(result.probabilities, { flap_now: 0.7, flap_at_8: 0.1, flap_at_16: 0.1, double_flap: 0, triple_flap: 0, no_flap: 0.1 });
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
    data.answers.plan.probabilities = { flap_now: 0.7, flap_at_8: 0.1, flap_at_16: 0.1, double_flap: 0, triple_flap: 0 };
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
    const data2 = validAnswer();
    data2.answers.plan.probabilities.flap_now = 1.5;
    assert.throws(() => JevContract.parseResponse(data2), /Invalid Jev response/);
});

test('parseResponse rejects probabilities that do not sum to ~1', () => {
    const data = validAnswer();
    data.answers.plan.probabilities = { flap_now: 0.5, flap_at_8: 0.5, flap_at_16: 0.5, double_flap: 0.5, triple_flap: 0.5, no_flap: 0.5 };
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
});

test('parseResponse tolerates a small rounding slack in probabilities', () => {
    const data = validAnswer();
    data.answers.plan.probabilities = { flap_now: 0.71, flap_at_8: 0.1, flap_at_16: 0.1, double_flap: 0, triple_flap: 0, no_flap: 0.1 };
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
