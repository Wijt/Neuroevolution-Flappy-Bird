const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function makeDocument() {
    return {
        hidden: false,
        addEventListener() {},
        removeEventListener() {},
        body: { appendChild() {}, removeChild() {}, classList: { add() {}, remove() {} } },
        createElement() {
            return {
                style: {},
                classList: { add() {}, remove() {}, toggle() {} },
                addEventListener() {},
                appendChild() {},
                removeChild() {},
                setAttribute() {},
                querySelector() { return null; },
                remove() {}
            };
        },
        querySelector() { return null; }
    };
}

function sceneHarness(fetchImpl) {
    let now = 0;
    const context = vm.createContext({
        console, AbortController, setTimeout, clearTimeout,
        performance: { now: () => now },
        fetch: fetchImpl || (async () => { throw new Error('no fetch configured'); }),
        document: makeDocument(),
        window: { innerWidth: 1400, addEventListener() {}, removeEventListener() {} },
        width: 450, height: 800,
        BIRD_X: 100, BIRD_R: 25, BIRD_JUMP_POWER: 6,
        GRAVITY: 0.4, GROUND_HEIGHT: 50, PIPE_WIDTH: 50, PIPE_BETWEEN: 200,
        PIPE_GAP_H: 125, PIPE_SCROOL: 2, PIPE_NO_GAP_ZONE: 150,
        BG_COLOR: '#1b1b2f', GROUND_COLOR: '#162447',
        random: (a, b) => (a + b) / 2,
        circleRect: () => false,
        // p5 drawing no-ops used by draw(); not exercised by these tests but referenced.
        background() {}, push() {}, pop() {}, fill() {}, noFill() {}, stroke() {}, noStroke() {},
        strokeWeight() {}, rect() {}, ellipse() {}, line() {}, text() {}, textAlign() {}, textSize() {},
        beginShape() {}, endShape() {}, vertex() {}, color: (...a) => a,
        CENTER: 'center',
        Scene: class { update() {} start() {} exit() {} }
    });
    for (const file of [
        'data/flappybird/bird.js',
        'data/flappybird/pipe.js',
        'data/jev-physics.js',
        'data/jev-contract.js',
        'data/scenes/watch-scene.js'
    ]) {
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    }
    const scene = vm.runInContext('new WatchScene()', context);
    context.sceneManager = { getActiveScene: () => scene };
    scene.resetGame();
    return {
        scene,
        context,
        setNow: v => { now = v; },
        tick: () => { now += 1000 / 60; scene.update(); }
    };
}

const HORIZON = 12;

function answer(plan, overrides) {
    return Object.assign({
        id: 0,
        plan,
        probabilities: { flap_now: 0.1, flap_at_4: 0.1, flap_at_8: 0.1, no_flap: 0.7, [plan]: 0.7 },
        confidence: 0.9,
        model: 'jev-latest',
        usage: { input_tokens: 500, output_tokens: 20 },
        latencyMs: 42
    }, overrides || {});
}
function jsonResponse(status, body) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('game keeps stepping while a request is pending', () => {
    const { scene, tick } = sceneHarness(() => new Promise(() => {})); // never resolves
    scene.state = 'running';
    const y0 = scene.bird.pos.y;
    const pipeX0 = scene.pipes[0].pos.x;
    for (let i = 0; i < 30; i++) tick();
    assert.notEqual(scene.bird.pos.y, y0);
    assert.notEqual(scene.pipes[0].pos.x, pipeX0);
});

test('late answer falls back to the physics heuristic and is labelled late', () => {
    const { scene, tick, context } = sceneHarness(() => new Promise(() => {}));
    scene.state = 'running';
    // No answer for window 0 was requested: the window must commit immediately with the
    // physics fallback, labelled late, never mistaken for a Jev decision.
    tick();
    const expected = context.JevPhysics.bestPlan(scene.currentForecasts);
    assert.equal(scene.currentPlan, expected);
    assert.equal(scene.lateCount, 1);
    assert.equal(scene.history[0].late, true);
    assert.equal(scene.history[0].probabilities, null);
});

test('start primes window 0 and waits for it briefly, then applies it without a late mark', async () => {
    let resolve;
    const { scene, tick, context } = sceneHarness(() => new Promise(r => { resolve = r; }));
    scene.handleStartClick();
    assert.equal(scene.state, 'running');
    assert.equal(scene.requestsSent, 1);
    const y = scene.bird.pos.y;
    for (let i = 0; i < 10; i++) tick();           // ~170 ms: still inside the warm-up hold
    assert.equal(scene.bird.pos.y, y);
    resolve(jsonResponse(200, answer('flap_at_4', { id: 0 })));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    tick();
    assert.equal(scene.currentPlan, 'flap_at_4');
    assert.equal(scene.lateCount, 0);
    assert.equal(scene.requestsSent, 2);            // window 1 was pipelined at commit
});

test('warm-up hold is bounded; the game starts anyway with a late fallback', () => {
    const { scene, tick, context } = sceneHarness(() => new Promise(() => {}));
    scene.handleStartClick();
    for (let i = 0; i < 60; i++) tick();            // > WARMUP_MS
    assert.ok(scene.history.length >= 1);
    assert.equal(scene.history[0].late, true);
});

test('pausing keeps the in-flight answer and reuses it on resume; nothing new is sent while paused', async () => {
    let resolve;
    let calls = 0;
    const { scene, tick } = sceneHarness(() => { calls++; return new Promise(r => { resolve = r; }); });
    scene.handleStartClick();                        // request 0 in flight
    scene.handleStartClick();                        // pause
    assert.equal(scene.state, 'paused');
    const sent = calls;
    for (let i = 0; i < 30; i++) tick();
    assert.equal(calls, sent);
    resolve(jsonResponse(200, answer('flap_now', { id: 0 })));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(scene.pendingResponses[0].status, 'resolved');
    scene.handleStartClick();                        // resume
    tick();
    assert.equal(scene.currentPlan, 'flap_now');
    assert.equal(scene.lateCount, 0);
});

test('a resolved answer for the current window is applied, not late', () => {
    const { scene, tick } = sceneHarness(() => new Promise(() => {}));
    scene.state = 'running';
    scene.pendingResponses[0] = {
        status: 'resolved', plan: 'flap_at_4', probabilities: { flap_now: 0, flap_at_4: 0.8, flap_at_8: 0.1, no_flap: 0.1 },
        confidence: 0.8, latencyMs: 55, usage: { input_tokens: 400, output_tokens: 10 }
    };
    tick();
    assert.equal(scene.currentPlan, 'flap_at_4');
    assert.equal(scene.lateCount, 0);
    assert.equal(scene.history[0].late, false);
});

test('stale response is ignored after a reset', async () => {
    let resolve;
    const { scene, tick } = sceneHarness(() => new Promise(r => { resolve = r; }));
    scene.state = 'running';
    tick(); // commits window 0 (late), fires request for window 1
    const generationAtRequest = scene.generation;
    assert.equal(scene.requestsSent, 1);
    scene.resetGame(); // must bump generation and cancel the in-flight request
    assert.notEqual(scene.generation, generationAtRequest);
    resolve(jsonResponse(200, answer('flap_now', { id: 1 })));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(scene.pendingResponses[1], undefined);
});

test('no requests are sent when dead, paused, not started, or hidden', async () => {
    let calls = 0;
    const { scene, tick, context } = sceneHarness(async () => { calls++; return jsonResponse(200, answer('no_flap')); });

    // idle (not started / not running)
    for (let i = 0; i < 20; i++) tick();
    assert.equal(calls, 0);

    // paused
    scene.state = 'paused';
    for (let i = 0; i < 20; i++) tick();
    assert.equal(calls, 0);

    // dead
    scene.state = 'dead';
    for (let i = 0; i < 20; i++) tick();
    assert.equal(calls, 0);

    // hidden while running
    scene.resetGame();
    scene.state = 'running';
    context.document.hidden = true;
    tick();
    assert.equal(calls, 0);
    context.document.hidden = false;
});

test('flap fires at the plan\'s tick', () => {
    const { scene, tick } = sceneHarness(() => new Promise(() => {}));
    scene.state = 'running';
    scene.pendingResponses[0] = {
        status: 'resolved', plan: 'flap_at_4', probabilities: { flap_now: 0, flap_at_4: 1, flap_at_8: 0, no_flap: 0 },
        confidence: 1, latencyMs: 10, usage: null
    };
    // Ticks 0..3: no flap yet, bird keeps falling under gravity from velocity 0.
    for (let i = 0; i < 4; i++) tick();
    assert.ok(scene.bird.velocity > 0, 'bird should be falling before the flap tick');
    // Tick index 4 (the 5th tick of the window) is when flap_at_4 fires: jump() sets
    // velocity to -6, then the same tick's physics step applies one tick of gravity.
    tick();
    assert.equal(scene.bird.velocity, -6 + GRAVITY_FOR_TEST());
    function GRAVITY_FOR_TEST() { return 0.4; }
});

test('request for window k+1 is sent at the start of window k with an advanced state', async () => {
    let capturedBody = null;
    const { scene, tick } = sceneHarness(async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return new Promise(() => {}); // leave pending; we only care about the body sent
    });
    scene.state = 'running';
    const before = scene.gameState();
    const leftBefore = before.pipes[0].left;
    tick(); // commits window 0, immediately sends request for window 1
    assert.ok(capturedBody, 'expected a request to have been sent');
    assert.equal(capturedBody.id, 1);
    assert.equal(capturedBody.state.pipes[0].left, leftBefore - 2 /* PIPE_SCROOL */ * HORIZON);
});

test('death cancels the in-flight request', async () => {
    let aborted = false;
    const { scene, tick } = sceneHarness(() => new Promise((resolve, reject) => {
        // never resolves on its own; only rejects if aborted
    }));
    scene.state = 'running';
    tick(); // window 0 commits, request for window 1 goes out
    const rec = scene.pendingResponses[1];
    assert.ok(rec && rec.controller);
    const originalAbort = rec.controller.abort.bind(rec.controller);
    rec.controller.abort = () => { aborted = true; originalAbort(); };
    scene.die();
    assert.equal(aborted, true);
    assert.equal(Object.keys(scene.pendingResponses).length, 0);
    assert.equal(scene.state, 'dead');
});

test('a session request cap stops further requests', () => {
    let calls = 0;
    const { scene, tick } = sceneHarness(() => { calls++; return new Promise(() => {}); });
    scene.state = 'running';
    scene.requestCap = 1;
    for (let i = 0; i < HORIZON * 5; i++) tick();
    assert.equal(calls, 1);
    assert.equal(scene.requestsSent, 1);
    assert.equal(scene.state, 'paused');
});
