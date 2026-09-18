// Shared exact short-horizon physics. Predictions are evidence, not model decisions.
(function (root) {
    function predict(state, action, ticks = 30) {
        let y = state.bird.y;
        let velocity = action === 'flap' ? -state.physics.jumpPower : state.bird.velocity;
        const radius = state.bird.collisionRadius;
        let firstCollisionTick = null;
        let minY = y;
        let maxY = y;
        let yAtDecision = y;
        for (let tick = 1; tick <= ticks; tick++) {
            y += velocity;
            velocity += state.physics.gravity;
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            let collision = y - radius <= 0 || y + radius >= state.world.groundY;
            for (const pipe of state.pipes) {
                const left = pipe.left - tick * state.physics.pipeSpeed;
                const right = pipe.right - tick * state.physics.pipeSpeed;
                const dx = Math.max(left - state.bird.x, 0, state.bird.x - right);
                const topDistance = Math.max(y - pipe.gapTop, 0);
                const bottomDistance = Math.max(pipe.gapBottom - y, 0);
                if (dx * dx + Math.min(topDistance * topDistance, bottomDistance * bottomDistance) <= radius * radius) collision = true;
            }
            if (collision && firstCollisionTick === null) firstCollisionTick = tick;
            if (tick === state.decisionFrames) yAtDecision = y;
        }
        return { yAtDecision, yAfter30Ticks: y, minY, maxY, firstCollisionTick,
            safeUntilNextDecision: firstCollisionTick === null || firstCollisionTick > state.decisionFrames };
    }
    function evidence(state) {
        const pipe = state.pipes[0];
        return {
            motion: state.bird.velocity < 0 ? 'rising' : 'falling or stationary',
            targetY: (pipe.gapTop + pipe.gapBottom) / 2,
            birdRelativeToGapCenter: state.bird.y < (pipe.gapTop + pipe.gapBottom) / 2 ? 'above' : 'below',
            ticksUntilPipe: Math.max(0, (pipe.left - state.bird.x - state.bird.collisionRadius) / state.physics.pipeSpeed),
            flap: predict(state, 'flap'), coast: predict(state, 'coast'),
            forecastAssumption: '30-tick forecasts assume NO later flaps. A new decision is allowed after 6 ticks; later collisions are not inevitable.'
        };
    }
    const api = { predict, evidence };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JevPhysics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
