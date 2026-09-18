const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const JevPhysics = require('../data/jev-physics');

// Loads the real Bird/Pipe classes into a vm context with just enough globals for them to run
// headless (no p5), matching test/watch.test.js's harness pattern.
function gameContext(height) {
    const context = vm.createContext({
        console, height, width: 450,
        BIRD_R: 25, BIRD_X: 100, BIRD_JUMP_POWER: 6, GRAVITY: 0.4,
        GROUND_HEIGHT: 50, PIPE_WIDTH: 50, PIPE_GAP_H: 125, PIPE_SCROOL: 2,
        PIPE_BETWEEN: 200, PIPE_NO_GAP_ZONE: 150, DEBUG_MODE: false,
        sqrt: Math.sqrt, abs: Math.abs,
        random: (a, b) => (a + b) / 2,
        sceneManager: { getActiveScene: () => ({ pipes: [] }) }
    });
    for (const file of ['data/constants.js', 'data/utils.js', 'data/flappybird/bird.js', 'data/flappybird/pipe.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
    }
    return context;
}

function makeState(overrides = {}) {
    return {
        bird: { x: 100, y: 300, velocity: 0, radius: 15 },
        world: { width: 450, groundY: 750 },
        physics: { gravity: 0.4, jumpPower: 6, pipeSpeed: 2 },
        pipes: [{ left: 400, right: 450, gapTop: 260, gapBottom: 385 }],
        ...overrides
    };
}

test('simulate replicates Bird.update tick math exactly (no flap)', () => {
    const context = gameContext(800);
    const bird = vm.runInContext('new Bird(100, 300)', context);
    const state = makeState();
    const sim = JevPhysics.simulate(state, [], 20);
    for (let t = 0; t < 20; t++) {
        bird.update();
        assert.ok(Math.abs(sim.points[t].y - bird.pos.y) < 1e-9, `tick ${t} y mismatch`);
        assert.ok(Math.abs(sim.points[t].velocity - bird.velocity) < 1e-9, `tick ${t} velocity mismatch`);
    }
});

test('simulate replicates a flap at the start of the given tick', () => {
    const context = gameContext(800);
    const bird = vm.runInContext('new Bird(100, 300)', context);
    bird.velocity = 1.5;
    const state = makeState({ bird: { x: 100, y: 300, velocity: 1.5, radius: 15 } });
    const flapTick = 4;
    const sim = JevPhysics.simulate(state, [flapTick], 10);
    for (let t = 0; t < 10; t++) {
        if (t === flapTick) bird.jump();
        bird.update();
        assert.ok(Math.abs(sim.points[t].y - bird.pos.y) < 1e-9, `tick ${t} y mismatch`);
        assert.ok(Math.abs(sim.points[t].velocity - bird.velocity) < 1e-9, `tick ${t} velocity mismatch`);
    }
});

test('detects a top pipe collision', () => {
    // Bird flies straight up into the top pipe rect.
    const state = makeState({
        bird: { x: 425, y: 270, velocity: -10, radius: 15 },
        pipes: [{ left: 400, right: 450, gapTop: 260, gapBottom: 385 }]
    });
    const sim = JevPhysics.simulate(state, [], 5);
    assert.ok(sim.collision);
    assert.equal(sim.collision.with, 'top pipe');
});

test('detects a bottom pipe collision', () => {
    const state = makeState({
        bird: { x: 425, y: 380, velocity: 10, radius: 15 },
        pipes: [{ left: 400, right: 450, gapTop: 260, gapBottom: 385 }]
    });
    const sim = JevPhysics.simulate(state, [], 5);
    assert.ok(sim.collision);
    assert.equal(sim.collision.with, 'bottom pipe');
});

test('detects a ground collision', () => {
    const state = makeState({
        bird: { x: 100, y: 730, velocity: 10, radius: 15 },
        world: { width: 450, groundY: 750 },
        pipes: [{ left: 2000, right: 2050, gapTop: 260, gapBottom: 385 }]
    });
    const sim = JevPhysics.simulate(state, [], 5);
    assert.ok(sim.collision);
    assert.equal(sim.collision.with, 'ground');
});

test('no ceiling collision: bird may fly above y=0 unharmed', () => {
    const state = makeState({ bird: { x: 100, y: 20, velocity: -20, radius: 15 }, pipes: [{ left: 2000, right: 2050, gapTop: 260, gapBottom: 385 }] });
    const sim = JevPhysics.simulate(state, [], 5);
    assert.equal(sim.collision, null);
});

test('passedGap is true once the bird clears pipes[0] without colliding', () => {
    const state = makeState({
        bird: { x: 440, y: 320, velocity: 0, radius: 15 },
        pipes: [{ left: 400, right: 450, gapTop: 260, gapBottom: 385 }]
    });
    const sim = JevPhysics.simulate(state, [], 10);
    assert.equal(sim.collision, null);
    assert.equal(sim.passedGap, true);
});

test('advance() matches stepping the real Bird + Pipe classes HORIZON times', () => {
    let pipeList = [];
    const ctx2 = vm.createContext({
        console, height: 800, width: 450,
        BIRD_R: 25, BIRD_X: 100, BIRD_JUMP_POWER: 6, GRAVITY: 0.4,
        GROUND_HEIGHT: 50, PIPE_WIDTH: 50, PIPE_GAP_H: 125, PIPE_SCROOL: 2,
        PIPE_BETWEEN: 200, PIPE_NO_GAP_ZONE: 150, DEBUG_MODE: false,
        sqrt: Math.sqrt, abs: Math.abs,
        random: (a, b) => (a + b) / 2,
        sceneManager: { getActiveScene: () => ({ get pipes() { return pipeList; } }) }
    });
    for (const file of ['data/constants.js', 'data/utils.js', 'data/flappybird/bird.js', 'data/flappybird/pipe.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx2);
    }
    const realBird = vm.runInContext('new Bird(100, 300)', ctx2);
    realBird.velocity = 2;
    // The Pipe constructor pushes itself into sceneManager.getActiveScene().pipes (= pipeList).
    vm.runInContext('new Pipe(400, 322.5)', ctx2); // gapTop 260, gapBottom 385
    vm.runInContext('new Pipe(650, 400)', ctx2);

    const state = {
        bird: { x: realBird.pos.x, y: realBird.pos.y, velocity: realBird.velocity, radius: 15 },
        world: { width: 450, groundY: 750 },
        physics: { gravity: 0.4, jumpPower: 6, pipeSpeed: 2 },
        pipes: pipeList.map(p => ({ left: p.topPipe.x1, right: p.topPipe.x2, gapTop: p.topPipe.y2, gapBottom: p.bottomPipe.y1 }))
    };

    const advanced = JevPhysics.advance(state, 'flap_at_8');
    for (let t = 0; t < JevPhysics.HORIZON; t++) {
        if (JevPhysics.FLAP_TICKS.flap_at_8.includes(t)) realBird.jump();
        realBird.update();
        pipeList.forEach(p => p.update());
    }
    assert.ok(Math.abs(advanced.bird.y - realBird.pos.y) < 1e-9);
    assert.ok(Math.abs(advanced.bird.velocity - realBird.velocity) < 1e-9);
    const expectedPipes = pipeList
        .map(p => ({ left: p.topPipe.x1, right: p.topPipe.x2, gapTop: p.topPipe.y2, gapBottom: p.bottomPipe.y1 }))
        .filter(p => p.right >= advanced.bird.x - advanced.bird.radius)
        .sort((a, b) => a.left - b.left);
    assert.deepEqual(advanced.pipes, expectedPipes);
});

test('advance() drops pipes that have fully scrolled past the bird', () => {
    const state = makeState({
        bird: { x: 100, y: 300, velocity: 0, radius: 15 },
        pipes: [
            { left: -100, right: -50, gapTop: 260, gapBottom: 385 }, // will be far behind after shift
            { left: 400, right: 450, gapTop: 260, gapBottom: 385 }
        ]
    });
    const advanced = JevPhysics.advance(state, 'no_flap');
    assert.equal(advanced.pipes.length, 1);
    assert.equal(advanced.pipes[0].left, 400 - 2 * JevPhysics.HORIZON);
});

test('forecastPlans returns a PlanOutcome per plan with the documented shape', () => {
    const state = makeState();
    const forecasts = JevPhysics.forecastPlans(state);
    assert.deepEqual(Object.keys(forecasts).sort(), [...JevPhysics.PLANS].sort());
    for (const plan of JevPhysics.PLANS) {
        const outcome = forecasts[plan];
        assert.deepEqual(outcome.flapTicks, JevPhysics.FLAP_TICKS[plan]);
        assert.ok(Number.isFinite(outcome.endY));
        assert.ok(Number.isFinite(outcome.endVelocity));
        assert.ok(Number.isFinite(outcome.offsetFromGapCenterAtEnd));
        assert.ok(Number.isFinite(outcome.minClearance));
        assert.ok(outcome.collisionWithinWindow === null || Number.isFinite(outcome.collisionWithinWindow.tick));
        assert.ok(outcome.collisionIfCoastingAfter === null || Number.isFinite(outcome.collisionIfCoastingAfter.tick));
        assert.equal(typeof outcome.passesGapIfCoastingAfter, 'boolean');
        assert.equal(outcome.trajectory.length, JevPhysics.HORIZON + JevPhysics.LOOKAHEAD);
        assert.deepEqual(Object.keys(outcome.trajectory[0]).sort(), ['tick', 'y']);
    }
});

test('bestPlan excludes plans fatal within the window', () => {
    const forecasts = {
        flap_now: { collisionWithinWindow: { tick: 3, with: 'ground' }, collisionIfCoastingAfter: null, offsetFromGapCenterAtEnd: 0 },
        flap_at_8: { collisionWithinWindow: null, collisionIfCoastingAfter: null, offsetFromGapCenterAtEnd: 5 },
        flap_at_16: { collisionWithinWindow: null, collisionIfCoastingAfter: { tick: 20, with: 'top pipe' }, offsetFromGapCenterAtEnd: 1 },
        no_flap: { collisionWithinWindow: { tick: 9, with: 'ground' }, collisionIfCoastingAfter: null, offsetFromGapCenterAtEnd: 0 }
    };
    assert.equal(JevPhysics.bestPlan(forecasts), 'flap_at_8');
});

test('bestPlan prefers no coasting collision, then smallest offset', () => {
    const forecasts = {
        flap_now: { collisionWithinWindow: null, collisionIfCoastingAfter: null, offsetFromGapCenterAtEnd: -10 },
        flap_at_8: { collisionWithinWindow: null, collisionIfCoastingAfter: null, offsetFromGapCenterAtEnd: 2 },
        flap_at_16: { collisionWithinWindow: null, collisionIfCoastingAfter: { tick: 15, with: 'ground' }, offsetFromGapCenterAtEnd: 0 },
        no_flap: { collisionWithinWindow: null, collisionIfCoastingAfter: null, offsetFromGapCenterAtEnd: 3 }
    };
    assert.equal(JevPhysics.bestPlan(forecasts), 'flap_at_8');
});

test('bestPlan picks the latest collision tick when every plan is fatal', () => {
    const forecasts = {
        flap_now: { collisionWithinWindow: { tick: 2, with: 'ground' } },
        flap_at_8: { collisionWithinWindow: { tick: 11, with: 'ground' } },
        flap_at_16: { collisionWithinWindow: { tick: 5, with: 'top pipe' } },
        no_flap: { collisionWithinWindow: { tick: 3, with: 'ground' } }
    };
    assert.equal(JevPhysics.bestPlan(forecasts), 'flap_at_8');
});

test('triple_flap fires three jumps and climbs far more than a single flap', () => {
    const state = makeState();
    const f = JevPhysics.forecastPlans(state);
    assert.ok(f.triple_flap.endY < f.flap_now.endY - 40, 'three flaps must gain much more height than one');
    assert.ok(f.double_flap.endY < f.flap_now.endY, 'two flaps must gain more height than one');
    // Parity: advance() with a multi-flap plan equals stepping tick by tick with jumps.
    let y = state.bird.y, v = state.bird.velocity;
    for (let t = 0; t < JevPhysics.HORIZON; t++) {
        if (JevPhysics.FLAP_TICKS.triple_flap.includes(t)) v = -state.physics.jumpPower;
        if (y < state.world.groundY) { y += v; v += state.physics.gravity; } else { y = state.world.groundY; }
    }
    const adv = JevPhysics.advance(state, 'triple_flap');
    assert.ok(Math.abs(adv.bird.y - y) < 1e-9);
    assert.ok(Math.abs(adv.bird.velocity - v) < 1e-9);
});
