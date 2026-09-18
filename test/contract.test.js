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

test('buildRequest produces the pure sensor shape with no outcome words', () => {
    const request = JevContract.buildRequest(makeState());
    assert.equal(request.model, 'jev-latest');

    const q = request.questions;
    assert.equal(q.danger.type, 'noul');
    assert.equal(q.climb.type, 'choice');
    assert.deepEqual(Object.keys(q.climb.criteria).sort(), ['none', 'one_flap', 'three_flaps', 'two_flaps'].sort());
    assert.equal(q.timing.type, 'choice');
    assert.deepEqual(Object.keys(q.timing.criteria).sort(), ['late', 'now', 'soon'].sort());

    const state = request.state;
    assert.deepEqual(Object.keys(state).sort(), ['game', 'hole', 'next_hole', 'pipe', 'rays', 'you'].sort());
    assert.match(state.you, /^falling/);
    assert.match(state.hole, /^BELOW you by \d+ px$/);
    assert.match(state.next_hole, /^\d+ px lower than this one$/);
    assert.deepEqual(Object.keys(state.rays), ['straight ahead', 'ahead and up', 'ahead and down']);
    assert.equal(state.rays['ahead and down'], 'the bottom pipe');
    assert.equal(state.rays['straight ahead'], 'the hole - it goes through');

    // Nothing about option outcomes may reach the model, in the sensor state.
    // (The rays' "too high, nothing there" phrase is a v2-carried ray description, not
    // an option-outcome judgement, so outcome words are checked outside `rays`.)
    const { rays, ...outcomeFreeFields } = state;
    const stateText = JSON.stringify(outcomeFreeFields);
    assert.equal(/tick/i.test(JSON.stringify(state)), false);
    for (const word of ['Safe', 'CRASH', 'too low', 'too high', 'level with']) {
        assert.equal(stateText.includes(word), false, `state must not contain "${word}"`);
    }
    assert.ok(JSON.stringify(request).length < 2100, `request too long: ${JSON.stringify(request).length} chars`);
});

test('hole straight ahead and pipe distance buckets', () => {
    const state = makeState();
    state.bird.y = (state.pipes[0].gapTop + state.pipes[0].gapBottom) / 2;
    state.bird.velocity = 0;
    const st = JevContract.buildRequest(state).state;
    assert.match(st.you, /^level/);
    assert.equal(st.hole, 'straight ahead at your height');

    state.pipes = [{ left: 1000, right: 1050, gapTop: 260, gapBottom: 385 }];
    const far = JevContract.buildRequest(state).state;
    assert.match(far.pipe, /^far \(about \d+(\.\d)? s away\)$/);

    state.bird.x = 1010;
    const inside = JevContract.buildRequest(state).state;
    assert.equal(inside.pipe, 'you are inside the pipe right now');
});

test('buildRequest omits next_hole when there is only one pipe', () => {
    const state = makeState();
    state.pipes = [state.pipes[0]];
    const request = JevContract.buildRequest(state);
    assert.equal('next_hole' in request.state, false);
});

test('buildRequest custom model is forwarded', () => {
    const request = JevContract.buildRequest(makeState(), 'jev-custom');
    assert.equal(request.model, 'jev-custom');
});

test('composePlan uses the expected number of flaps and a danger floor', () => {
    const dist = (none, one, two, three) => ({ probabilities: { none, one_flap: one, two_flaps: two, three_flaps: three } });
    const answers = (climb, timing, danger) => ({ climb, timing: { choice: timing }, danger: { noul: danger } });
    // 55/34/8/2: argmax says none, expectation 0.56 -> one flap
    assert.equal(JevContract.composePlan(answers(dist(0.55, 0.34, 0.08, 0.02), 'now', 0.3)), 'flap_now');
    // 95/2/2/1 -> 0.09 -> none, low danger keeps it none
    assert.equal(JevContract.composePlan(answers(dist(0.95, 0.02, 0.02, 0.01), 'now', 0.4)), 'no_flap');
    // ... but danger >= 0.6 turns a marginal none into one flap
    assert.equal(JevContract.composePlan(answers(dist(0.95, 0.02, 0.02, 0.01), 'soon', 0.75)), 'flap_at_8');
    // 4/35/48/13 -> 1.7 -> two flaps
    assert.equal(JevContract.composePlan(answers(dist(0.04, 0.35, 0.48, 0.13), 'now', 0.7)), 'double_flap');
    // 11/13/38/38 -> 2.03 -> two flaps; 2/7/20/71 -> 2.6 -> three
    assert.equal(JevContract.composePlan(answers(dist(0.11, 0.13, 0.38, 0.38), 'now', 0.9)), 'double_flap');
    assert.equal(JevContract.composePlan(answers(dist(0.02, 0.07, 0.2, 0.71), 'now', 0.9)), 'triple_flap');
    assert.equal(JevContract.expectedFlaps(dist(0.55, 0.34, 0.08, 0.02)).toFixed(2), '0.56');
});

test('composePlan follows the climb/timing table when only a choice is given', () => {
    const withClimb = (climb, timing) => ({ climb: { choice: climb }, timing: { choice: timing } });
    assert.equal(JevContract.composePlan(withClimb('none', 'now')), 'no_flap');
    assert.equal(JevContract.composePlan(withClimb('one_flap', 'now')), 'flap_now');
    assert.equal(JevContract.composePlan(withClimb('one_flap', 'soon')), 'flap_at_8');
    assert.equal(JevContract.composePlan(withClimb('one_flap', 'late')), 'flap_at_16');
    assert.equal(JevContract.composePlan(withClimb('two_flaps', 'now')), 'double_flap');
    assert.equal(JevContract.composePlan(withClimb('three_flaps', 'late')), 'triple_flap');
});

function validAnswer(overrides = {}) {
    return {
        model: 'jev-latest',
        usage: { input_tokens: 500, output_tokens: 10 },
        answers: {
            danger: { type: 'noul', noul: 0.2 },
            climb: {
                type: 'choice', choice: 'one_flap',
                probabilities: { none: 0.1, one_flap: 0.7, two_flaps: 0.1, three_flaps: 0.1 },
                confidence: 0.85
            },
            timing: {
                type: 'choice', choice: 'now',
                probabilities: { now: 0.8, soon: 0.1, late: 0.1 },
                confidence: 0.9
            },
            ...overrides
        }
    };
}

test('parseResponse accepts a valid answer and composes the plan', () => {
    const result = JevContract.parseResponse(validAnswer());
    assert.equal(result.plan, 'flap_now');
    assert.equal(result.answers.danger.noul, 0.2);
    assert.equal(result.answers.climb.choice, 'one_flap');
    assert.equal(result.answers.climb.confidence, 0.85);
    assert.deepEqual(result.answers.climb.probabilities, { none: 0.1, one_flap: 0.7, two_flaps: 0.1, three_flaps: 0.1 });
    assert.equal(result.answers.timing.choice, 'now');
    assert.equal(result.model, 'jev-latest');
    assert.deepEqual(result.usage, { input_tokens: 500, output_tokens: 10 });
});

test('parseResponse composes double_flap and triple_flap regardless of timing', () => {
    const data = validAnswer();
    data.answers.climb = {
        type: 'choice', choice: 'two_flaps',
        probabilities: { none: 0, one_flap: 0, two_flaps: 1, three_flaps: 0 }, confidence: 0.9
    };
    assert.equal(JevContract.parseResponse(data).plan, 'double_flap');

    const data2 = validAnswer();
    data2.answers.climb = {
        type: 'choice', choice: 'three_flaps',
        probabilities: { none: 0, one_flap: 0, two_flaps: 0, three_flaps: 1 }, confidence: 0.9
    };
    assert.equal(JevContract.parseResponse(data2).plan, 'triple_flap');
});

test('parseResponse defaults usage when missing', () => {
    const data = validAnswer();
    delete data.usage;
    const result = JevContract.parseResponse(data);
    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});

test('parseResponse rejects a danger answer with wrong type or out-of-range noul', () => {
    const badType = validAnswer();
    badType.answers.danger = { type: 'choice', noul: 0.5 };
    assert.throws(() => JevContract.parseResponse(badType), /Invalid Jev response/);

    const outOfRange = validAnswer();
    outOfRange.answers.danger = { type: 'noul', noul: 1.5 };
    assert.throws(() => JevContract.parseResponse(outOfRange), /Invalid Jev response/);
});

test('parseResponse rejects a climb choice not among its criteria', () => {
    const data = validAnswer();
    data.answers.climb.choice = 'four_flaps';
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
});

test('parseResponse rejects missing or out-of-range probabilities', () => {
    const data = validAnswer();
    delete data.answers.climb.probabilities.three_flaps;
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);

    const data2 = validAnswer();
    data2.answers.timing.probabilities.now = 1.5;
    assert.throws(() => JevContract.parseResponse(data2), /Invalid Jev response/);
});

test('parseResponse rejects probabilities that do not sum to ~1', () => {
    const data = validAnswer();
    data.answers.climb.probabilities = { none: 0.5, one_flap: 0.5, two_flaps: 0.5, three_flaps: 0.5 };
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
});

test('parseResponse tolerates a small rounding slack in probabilities', () => {
    const data = validAnswer();
    data.answers.climb.probabilities = { none: 0.1, one_flap: 0.71, two_flaps: 0.1, three_flaps: 0.1 };
    assert.doesNotThrow(() => JevContract.parseResponse(data));
});

test('parseResponse rejects confidence out of [0,1]', () => {
    const data = validAnswer();
    data.answers.timing.confidence = 1.2;
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
});

test('parseResponse rejects a non-choice answer type for climb/timing', () => {
    const data = validAnswer();
    data.answers.climb.type = 'text';
    assert.throws(() => JevContract.parseResponse(data), /Invalid Jev response/);
});

test('parseResponse rejects a missing answer', () => {
    assert.throws(() => JevContract.parseResponse({ answers: {} }), /Invalid Jev response/);
    assert.throws(() => JevContract.parseResponse({}), /Invalid Jev response/);
    const missingTiming = validAnswer();
    delete missingTiming.answers.timing;
    assert.throws(() => JevContract.parseResponse(missingTiming), /Invalid Jev response/);
});
