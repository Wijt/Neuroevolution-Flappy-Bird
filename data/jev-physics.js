// Pure, deterministic short-horizon physics shared by the server and the browser scene.
// No p5 globals: everything needed comes from the GameState argument.
(function (root) {
    // 24 ticks = 400 ms at 60 Hz. Measured Jev round trip through the proxy is ~250-300 ms,
    // so a 400 ms window lets the pipelined answer arrive in time almost always.
    const HORIZON = 24;
    const LOOKAHEAD = 36;
    const FLAP_TICK = { flap_now: 0, flap_at_8: 8, flap_at_16: 16, no_flap: null };
    const PLANS = Object.keys(FLAP_TICK);

    function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

    // Closest-point circle-rect distance, mirrors data/utils.js circleRect's edge testing.
    function closestPointDist(cx, cy, rect) {
        const testX = clamp(cx, rect.x1, rect.x2);
        const testY = clamp(cy, rect.y1, rect.y2);
        const dx = cx - testX;
        const dy = cy - testY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // Mirrors Bird.jump() (velocity = -jumpPower) followed by Bird.update():
    //   if (pos.y < groundY) { pos.y += velocity; velocity += gravity } else { pos.y = groundY }
    function stepBird(bird, flap, physics, groundY) {
        let { y, velocity } = bird;
        if (flap) velocity = -physics.jumpPower;
        if (y < groundY) {
            y += velocity;
            velocity += physics.gravity;
        } else {
            y = groundY;
        }
        return { y, velocity };
    }

    // Runs `ticks` ticks of the given flapTicks (0-indexed tick numbers at which a flap fires
    // at the START of that tick, before its position update). Returns per-tick points,
    // per-tick clearance (distance to nearest pipe/ground edge minus radius, negative if hit),
    // the first collision (if any) and whether the bird passed pipes[0] without colliding.
    function runSimulation(state, flapTicks, ticks) {
        const physics = state.physics;
        const groundY = state.world.groundY;
        const radius = state.bird.radius;
        const birdX = state.bird.x;
        let y = state.bird.y;
        let velocity = state.bird.velocity;
        let pipes = state.pipes.map(p => ({ left: p.left, right: p.right, gapTop: p.gapTop, gapBottom: p.gapBottom }));
        const points = [];
        const clearances = [];
        let collision = null;
        for (let t = 0; t < ticks; t++) {
            const flap = flapTicks.includes(t);
            ({ y, velocity } = stepBird({ y, velocity }, flap, physics, groundY));
            pipes = pipes.map(p => ({
                left: p.left - physics.pipeSpeed, right: p.right - physics.pipeSpeed,
                gapTop: p.gapTop, gapBottom: p.gapBottom
            }));
            let minDist = Infinity;
            let hitType = null;
            for (const p of pipes) {
                const topDist = closestPointDist(birdX, y, { x1: p.left, y1: 0, x2: p.right, y2: p.gapTop });
                const bottomDist = closestPointDist(birdX, y, { x1: p.left, y1: p.gapBottom, x2: p.right, y2: groundY });
                if (hitType === null && topDist <= radius) hitType = 'top pipe';
                if (hitType === null && bottomDist <= radius) hitType = 'bottom pipe';
                minDist = Math.min(minDist, topDist, bottomDist);
            }
            const groundDist = groundY - y;
            if (hitType === null && groundDist <= radius) hitType = 'ground';
            minDist = Math.min(minDist, groundDist);
            clearances.push(minDist - radius);
            if (collision === null && hitType) collision = { tick: t, with: hitType };
            points.push({ tick: t, y, velocity });
        }
        const finalPipe = pipes[0] || null;
        const passedGap = collision === null && finalPipe ? birdX > finalPipe.right : false;
        return { points, collision, clearances, passedGap };
    }

    function simulate(state, flapTicks, ticks) {
        const { points, collision, passedGap } = runSimulation(state, flapTicks, ticks);
        return { points, collision, passedGap };
    }

    // Exact game state HORIZON ticks later: bird stepped with `plan`'s single flap (if any),
    // pipes shifted by pipeSpeed*HORIZON, pipes that have fully scrolled past the bird dropped.
    // Pure; does not mutate `state`.
    function advance(state, plan) {
        const flapTick = FLAP_TICK[plan];
        const flapTicks = flapTick === null ? [] : [flapTick];
        const physics = state.physics;
        const groundY = state.world.groundY;
        let y = state.bird.y;
        let velocity = state.bird.velocity;
        for (let t = 0; t < HORIZON; t++) {
            const flap = flapTicks.includes(t);
            ({ y, velocity } = stepBird({ y, velocity }, flap, physics, groundY));
        }
        const shift = physics.pipeSpeed * HORIZON;
        const bird = { x: state.bird.x, y, velocity, radius: state.bird.radius };
        const pipes = state.pipes
            .map(p => ({ left: p.left - shift, right: p.right - shift, gapTop: p.gapTop, gapBottom: p.gapBottom }))
            .filter(p => p.right >= bird.x - bird.radius)
            .sort((a, b) => a.left - b.left);
        return {
            bird,
            world: { width: state.world.width, groundY: state.world.groundY },
            physics: { gravity: physics.gravity, jumpPower: physics.jumpPower, pipeSpeed: physics.pipeSpeed },
            pipes
        };
    }

    function forecastPlans(state) {
        const totalTicks = HORIZON + LOOKAHEAD;
        const nextPipe = state.pipes[0] || null;
        const gapCenter = nextPipe ? (nextPipe.gapTop + nextPipe.gapBottom) / 2 : null;
        const result = {};
        for (const plan of PLANS) {
            const flapTick = FLAP_TICK[plan];
            const flapTicks = flapTick === null ? [] : [flapTick];
            const sim = runSimulation(state, flapTicks, totalTicks);
            const windowPoint = sim.points[HORIZON - 1];
            const endY = windowPoint.y;
            const endVelocity = windowPoint.velocity;
            const minClearance = Math.min(...sim.clearances.slice(0, HORIZON));
            let collisionWithinWindow = null;
            let collisionIfCoastingAfter = null;
            if (sim.collision) {
                if (sim.collision.tick < HORIZON) collisionWithinWindow = sim.collision;
                else collisionIfCoastingAfter = sim.collision;
            }
            const passesGapIfCoastingAfter = collisionWithinWindow ? false : sim.passedGap;
            result[plan] = {
                flapAtTick: flapTick,
                endY, endVelocity,
                offsetFromGapCenterAtEnd: gapCenter === null ? null : endY - gapCenter,
                minClearance,
                collisionWithinWindow,
                collisionIfCoastingAfter,
                passesGapIfCoastingAfter,
                trajectory: sim.points.map(p => ({ tick: p.tick, y: p.y }))
            };
        }
        return result;
    }

    function bestPlan(forecasts) {
        const safe = PLANS.filter(p => !forecasts[p].collisionWithinWindow);
        if (safe.length === 0) {
            return PLANS.reduce((best, p) =>
                forecasts[p].collisionWithinWindow.tick > forecasts[best].collisionWithinWindow.tick ? p : best);
        }
        safe.sort((a, b) => {
            const aSafe = forecasts[a].collisionIfCoastingAfter === null ? 0 : 1;
            const bSafe = forecasts[b].collisionIfCoastingAfter === null ? 0 : 1;
            if (aSafe !== bSafe) return aSafe - bSafe;
            return Math.abs(forecasts[a].offsetFromGapCenterAtEnd) - Math.abs(forecasts[b].offsetFromGapCenterAtEnd);
        });
        return safe[0];
    }

    const api = { HORIZON, LOOKAHEAD, PLANS, FLAP_TICK, simulate, forecastPlans, advance, bestPlan };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JevPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
