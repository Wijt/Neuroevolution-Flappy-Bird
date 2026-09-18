const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function sceneHarness(fetchImpl) {
    let now = 0;
    const context = vm.createContext({ console, AbortController, setTimeout, clearTimeout,
        performance: { now: () => now }, fetch: fetchImpl,
        width: 450, height: 800, BIRD_X: 100, BIRD_R: 25, BIRD_JUMP_POWER: 6,
        GRAVITY: 0.4, GROUND_HEIGHT: 50, PIPE_WIDTH: 50, PIPE_BETWEEN: 200,
        PIPE_GAP_H: 125, PIPE_SCROOL: 2, PIPE_NO_GAP_ZONE: 150,
        random: (a, b) => (a + b) / 2, circleRect: () => false,
        Scene: class { update() {} start() {} exit() {} }
    });
    for (const file of ['data/flappybird/bird.js', 'data/flappybird/pipe.js', 'data/jev-physics.js', 'data/scenes/watch-scene.js']) {
        vm.runInContext(fs.readFileSync(file, 'utf8'), context);
    }
    const scene = vm.runInContext('new WatchScene()', context);
    context.sceneManager = { getActiveScene: () => scene };
    scene.pauseButton = { html() {} };
    scene.retryButton = { hide() {}, show() {} };
    scene.statusLabel = { elt: {} };
    let key = 'browser-key';
    scene.keyInput = { value(v) { if (v !== undefined) key = v; return key; } };
    scene.resetGame();
    return { scene, tick: () => { now += 17; scene.update(); } };
}
const result = action => ({ action, confidence: 0.9, decisionFrames: 6, latencyMs: 20 });
test('physics freezes while waiting; Jev flap is applied only after resume', async () => {
    let resolve;
    let calls = 0;
    const { scene, tick } = sceneHarness(() => { calls++; return new Promise(r => resolve = r); });
    scene.paused = false;
    tick();
    const y = scene.superBird.pos.y;
    const x = scene.pipes[0].pos.x;
    for (let i = 0; i < 100; i++) tick();
    assert.equal(calls, 1);
    assert.equal(scene.superBird.pos.y, y);
    assert.equal(scene.pipes[0].pos.x, x);
    scene.paused = true;
    resolve(Response.json(result('flap')));
    await new Promise(r => setImmediate(r));
    tick();
    assert.equal(scene.superBird.velocity, 0);
    scene.paused = false;
    tick();
    assert.ok(scene.superBird.velocity < 0);
    assert.ok(scene.superBird.pos.y < y);
});
test('old response cannot change a restarted game or an exited scene', async () => {
    let resolve;
    const { scene } = sceneHarness(() => new Promise(r => resolve = r));
    scene.paused = false;
    let pending = scene.requestDecision();
    scene.resetGame();
    resolve(Response.json(result('flap')));
    await pending;
    assert.equal(scene.readyDecision, null);
    assert.equal(scene.superBird.velocity, 0);
    scene.paused = false;
    scene.lastCallAt = -Infinity;
    pending = scene.requestDecision();
    scene.exit();
    resolve(Response.json(result('flap')));
    await pending;
    assert.equal(scene.readyDecision, null);
    assert.equal(scene.keyInput.value(), '');
});
test('service failure pauses without falling back; coast does not flap', async () => {
    const { scene, tick } = sceneHarness(async () => Response.json({ error: 'bad key' }, { status: 401 }));
    scene.paused = false;
    await scene.requestDecision();
    scene.paused = false;
    for (let i = 0; i < 20; i++) tick();
    assert.equal(scene.superBird.pos.y, 100);
    assert.equal(scene.error, 'bad key');
    scene.error = null;
    scene.readyDecision = result('coast');
    tick();
    assert.equal(scene.superBird.velocity, 0.4);
});
test('pipe recycling retains count and creates valid gaps; ground equality kills bird', () => {
    const { scene } = sceneHarness();
    const count = scene.pipes.length;
    scene.pipes[0].pos.x = -25;
    scene.step();
    assert.equal(scene.pipes.length, count);
    assert.ok(scene.pipes.at(-1).bottomPipe.y1 <= 750);
    scene.superBird.pos.y = 750;
    scene.step();
    assert.equal(scene.superBird.live, false);
});

test('dead, paused, exited and pending scenes never send additional requests', async () => {
    let calls = 0;
    const { scene, tick } = sceneHarness(async () => { calls++; return Response.json(result('coast')); });
    await scene.requestDecision();
    assert.equal(calls, 0);
    scene.paused = false;
    scene.superBird.live = false;
    for (let i = 0; i < 1000; i++) tick();
    await scene.requestDecision();
    assert.equal(calls, 0);
    scene.resetGame();
    scene.paused = false;
    scene.pending = true;
    await scene.requestDecision();
    assert.equal(calls, 0);
    scene.exit();
    await scene.requestDecision();
    assert.equal(calls, 0);
});
test('rising bird coasts without repeated paid decisions', () => {
    let calls = 0;
    const { scene, tick } = sceneHarness(() => { calls++; });
    scene.paused = false;
    scene.superBird.pos.y = 350;
    scene.superBird.jump();
    for (let i = 0; i < 15; i++) tick();
    assert.equal(calls, 0);
    assert.ok(scene.superBird.velocity > -6);
});
test('budget survives restart and prevents both API calls and automatic restart', async () => {
    let calls = 0;
    const { scene, tick } = sceneHarness(() => { calls++; });
    scene.calls = scene.callLimit;
    scene.resetGame();
    scene.paused = false;
    await scene.requestDecision();
    assert.equal(calls, 0);
    assert.equal(scene.paused, true);
    scene.autoRestart = { checked: () => true };
    scene.superBird.live = false;
    scene.deathAt = 0;
    for (let i = 0; i < 200; i++) tick();
    assert.equal(scene.superBird.live, false);
    assert.equal(calls, 0);
});
test('opt-in auto restart waits two seconds without calls during death', () => {
    let calls = 0;
    const { scene, tick } = sceneHarness(() => { calls++; });
    scene.autoRestart = { checked: () => true };
    scene.superBird.live = false;
    scene.deathAt = 0;
    scene.calls = 4;
    for (let i = 0; i < 117; i++) tick();
    assert.equal(scene.superBird.live, false);
    assert.equal(calls, 0);
    tick();
    assert.equal(scene.superBird.live, true);
    assert.equal(scene.calls, 4);
    assert.equal(calls, 0);
});
test('imminent ceiling collision overrides unsafe flap and labels intervention', () => {
    const { scene, tick } = sceneHarness();
    scene.paused = false;
    scene.superBird.pos.y = 40;
    scene.readyDecision = result('flap');
    tick();
    assert.ok(scene.superBird.velocity >= 0);
    assert.match(scene.statusLabel.elt.textContent, /safety: coast/);
});
