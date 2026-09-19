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

test('buildRequest produces the pure sensor shape with three yes/no questions', () => {
    const request = JevContract.buildRequest(makeState());
    assert.equal(request.model, 'jev-latest');

    const q = request.questions;
    assert.deepEqual(Object.keys(q).sort(), ['flap_now', 'flap_again', 'flap_later'].sort());
    assert.equal(q.flap_now.type, 'noul');
    assert.equal(q.flap_again.type, 'noul');
    assert.equal(q.flap_later.type, 'noul');
    assert.equal(typeof q.flap_now.instructions, 'string');
    assert.equal(typeof q.flap_again.instructions, 'string');
    assert.equal(typeof q.flap_later.instructions, 'string');

    const state = request.state;
    assert.deepEqual(Object.keys(state).sort(), ['game', 'hole', 'next_hole', 'pipe', 'rays', 'you'].sort());
    assert.match(state.you, /^falling/);
    assert.match(state.hole, /^BELOW you by \d+ px \(top edge .*\)$/);
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
    assert.ok(JSON.stringify(request).length < 2300, `request too long: ${JSON.stringify(request).length} chars`);
});

test('hole straight ahead and pipe distance buckets', () => {
    const state = makeState();
    state.bird.y = (state.pipes[0].gapTop + state.pipes[0].gapBottom) / 2;
    state.bird.velocity = 0;
    const st = JevContract.buildRequest(state).state;
    assert.match(st.you, /^level/);
    assert.match(st.hole, /^straight ahead at your height \(top edge/);

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

function answersOf(flap_now, flap_again, flap_later) {
    return {
        flap_now: { noul: flap_now },
        flap_again: { noul: flap_again },
        flap_later: { noul: flap_later }
    };
}

test('composePlan follows the four-row decision table at the default threshold (0.5)', () => {
    // flap_now < T, flap_later < T -> no_flap
    assert.equal(JevContract.composePlan(answersOf(0.2, 0.9, 0.2)), 'no_flap');
    // flap_now < T, flap_later >= T -> flap_at_12
    assert.equal(JevContract.composePlan(answersOf(0.2, 0.9, 0.9)), 'flap_at_12');
    // flap_now >= T, flap_again < T -> flap_now
    assert.equal(JevContract.composePlan(answersOf(0.9, 0.2, 0.9)), 'flap_now');
    // flap_now >= T, flap_again >= T -> double_flap
    assert.equal(JevContract.composePlan(answersOf(0.9, 0.9, 0.9)), 'double_flap');
});

test('composePlan boundary: noul equal to the threshold counts as yes', () => {
    assert.equal(JevContract.composePlan(answersOf(0.5, 0, 0), 0.5), 'flap_now');
    assert.equal(JevContract.composePlan(answersOf(0.5, 0.5, 0), 0.5), 'double_flap');
    assert.equal(JevContract.composePlan(answersOf(0, 0, 0.5), 0.5), 'flap_at_12');
});

test('a custom threshold of 0.7 flips a 0.6 answer to no', () => {
    // At the default threshold 0.5, flap_now = 0.6 counts as yes.
    assert.equal(JevContract.composePlan(answersOf(0.6, 0, 0)), 'flap_now');
    // At threshold 0.7 the same 0.6 answer counts as no.
    assert.equal(JevContract.composePlan(answersOf(0.6, 0, 0), 0.7), 'no_flap');
});

test('composePlan falls back to no_flap for missing or malformed answers', () => {
    assert.equal(JevContract.composePlan({}), 'no_flap');
    assert.equal(JevContract.composePlan(null), 'no_flap');
    assert.equal(JevContract.composePlan({ flap_now: { noul: NaN } }), 'no_flap');
});

function validAnswer(overrides = {}) {
    return {
        model: 'jev-latest',
        usage: { input_tokens: 500, output_tokens: 10 },
        answers: {
            flap_now: { type: 'noul', noul: 0.8 },
            flap_again: { type: 'noul', noul: 0.2 },
            flap_later: { type: 'noul', noul: 0.3 },
            ...overrides
        }
    };
}

test('parseResponse accepts a valid answer and composes the plan', () => {
    const result = JevContract.parseResponse(validAnswer());
    assert.equal(result.plan, 'flap_now'); // flap_now 0.8 >= 0.5, flap_again 0.2 < 0.5
    assert.equal(result.answers.flap_now.noul, 0.8);
    assert.equal(result.answers.flap_again.noul, 0.2);
    assert.equal(result.answers.flap_later.noul, 0.3);
    assert.equal(result.model, 'jev-latest');
    assert.deepEqual(result.usage, { input_tokens: 500, output_tokens: 10 });
});

test('parseResponse honours a custom threshold when composing the plan', () => {
    const result = JevContract.parseResponse(validAnswer(), 0.9);
    // flap_now 0.8 < 0.9, flap_later 0.3 < 0.9 -> no_flap
    assert.equal(result.plan, 'no_flap');
});

test('parseResponse defaults usage when missing', () => {
    const data = validAnswer();
    delete data.usage;
    const result = JevContract.parseResponse(data);
    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});

test('parseResponse rejects a missing or non-noul answer', () => {
    const missing = validAnswer();
    delete missing.answers.flap_later;
    assert.throws(() => JevContract.parseResponse(missing), /Invalid Jev response/);

    const wrongType = validAnswer();
    wrongType.answers.flap_now = { type: 'choice', noul: 0.5 };
    assert.throws(() => JevContract.parseResponse(wrongType), /Invalid Jev response/);

    const outOfRange = validAnswer();
    outOfRange.answers.flap_again = { type: 'noul', noul: 1.5 };
    assert.throws(() => JevContract.parseResponse(outOfRange), /Invalid Jev response/);

    const notFinite = validAnswer();
    notFinite.answers.flap_later = { type: 'noul', noul: NaN };
    assert.throws(() => JevContract.parseResponse(notFinite), /Invalid Jev response/);

    assert.throws(() => JevContract.parseResponse({ answers: {} }), /Invalid Jev response/);
    assert.throws(() => JevContract.parseResponse({}), /Invalid Jev response/);
});

test('hole sensor names both edges', () => {
    const state = makeState(); // bird y 300.44, gap 260..385
    const st = JevContract.buildRequest(state).state;
    assert.match(st.hole, /^BELOW you by 22 px \(top edge 40 px above you, bottom edge 85 px below you\)$/);
});

test('rayHits returns three named rays with finite coordinates', () => {
    const state = makeState();
    const hits = JevContract.rayHits(state);
    assert.equal(hits.length, 3);
    assert.deepEqual(hits.map(h => h.name), ['straight ahead', 'ahead and up', 'ahead and down']);
    for (const h of hits) {
        assert.ok(Number.isFinite(h.x), `${h.name} x must be finite`);
        assert.ok(Number.isFinite(h.y), `${h.name} y must be finite`);
        assert.equal(typeof h.hit, 'string');
    }
});

test('rayHits: straight ahead hits the hole when the bird is level with the gap center', () => {
    const state = makeState();
    state.bird.y = (state.pipes[0].gapTop + state.pipes[0].gapBottom) / 2;
    const hits = JevContract.rayHits(state);
    const straight = hits.find(h => h.name === 'straight ahead');
    assert.match(straight.hit, /^the hole/);
});

test('prompts can be overridden from the console; keys stay fixed and bad values fall back', () => {
    const defaults = JevContract.defaultPrompts();
    assert.deepEqual(Object.keys(defaults.questions).sort(), ['flap_now', 'flap_again', 'flap_later'].sort());
    const custom = {
        game: '  Sen kusun. Delikten gec.  ',
        questions: {
            flap_now: { instructions: 'Simdi kanat cirp mi?' },
            flap_again: { instructions: 'x'.repeat(5000) },
            unknown: { instructions: 'ignored' }
        }
    };
    const request = JevContract.buildRequest(makeState(), 'jev-latest', custom);
    assert.equal(request.state.game, 'Sen kusun. Delikten gec.');
    assert.equal(request.questions.flap_now.instructions, 'Simdi kanat cirp mi?');
    assert.equal(request.questions.flap_again.instructions, defaults.questions.flap_again.instructions); // too long -> default
    assert.equal(request.questions.unknown, undefined);
    assert.equal(request.questions.flap_now.type, 'noul');
    assert.equal(request.questions.flap_later.type, 'noul');
    // no overrides -> identical to defaults
    const plain = JevContract.buildRequest(makeState());
    assert.equal(plain.questions.flap_now.instructions, defaults.questions.flap_now.instructions);
});
