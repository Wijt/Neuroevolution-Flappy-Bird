// Builds the TypeSafe request (JevState + Choice question) and validates its response.
(function (root) {
    const physics = typeof module !== 'undefined' && module.exports ? require('./jev-physics') : root.JevPhysics;
    const PLANS = physics.PLANS;

    function round1(n) { return Math.round(n * 10) / 10; }

    const question = {
        type: 'choice',
        instructions:
            'Pick the plan for the next 12 ticks that keeps the bird alive and lines it up with the centre of `nextGap`. ' +
            'Use `plans`: each plan is simulated exactly. Any plan whose `collisionWithinWindow` is not "none" is fatal and must not be chosen. ' +
            'Among safe plans, prefer one whose `ifCoastingAfterWindow.collision` is "none" or latest, and whose `offsetFromGapCenterAtEnd` is closest to 0 ' +
            '(negative = above centre, positive = below). A new plan is chosen every 12 ticks, so a distant coasting collision can still be avoided later; ' +
            'do not flap when already above centre and rising.',
        criteria: {
            flap_now: { what: 'Flap immediately (tick 0), then coast for the rest of the window.', outcome: 'see `plans.flap_now`' },
            flap_at_4: { what: 'Coast 4 ticks, flap at tick 4, then coast.', outcome: 'see `plans.flap_at_4`' },
            flap_at_8: { what: 'Coast 8 ticks, flap at tick 8, then coast.', outcome: 'see `plans.flap_at_8`' },
            no_flap: { what: 'No flap for all 12 ticks; keep falling or keep current momentum.', outcome: 'see `plans.no_flap`' }
        }
    };

    function describeCollision(collision) {
        return collision ? `${collision.with} at tick ${collision.tick}` : 'none';
    }

    function buildJevState(state) {
        const forecasts = physics.forecastPlans(state);
        const bird = state.bird;
        const motion = bird.velocity < 0 ? 'rising' : bird.velocity > 0 ? 'falling' : 'level';
        const pipe0 = state.pipes[0];
        const gapCenter = (pipe0.gapTop + pipe0.gapBottom) / 2;
        const pipeLeftEdgeDistance = pipe0.left - bird.x - bird.radius;
        const ticksUntilPipe = Math.max(0, pipeLeftEdgeDistance / state.physics.pipeSpeed);
        const diff = bird.y - gapCenter;
        const birdRelativeToCenter = `${round1(Math.abs(diff))} px ${diff >= 0 ? 'below' : 'above'} centre`;

        const jevState = {
            game: 'Flappy Bird. The y axis grows DOWNWARD: a smaller y is higher on screen. The bird falls under gravity and a flap gives one upward impulse. Pipes scroll left; the bird must pass through the gap between the top pipe and the bottom pipe. Touching a pipe or the ground ends the game.',
            bird: { y: round1(bird.y), velocity: round1(bird.velocity), motion, collisionRadius: bird.radius },
            nextGap: {
                top: round1(pipe0.gapTop), bottom: round1(pipe0.gapBottom), center: round1(gapCenter),
                pipeLeftEdgeDistance: round1(pipeLeftEdgeDistance), ticksUntilPipe: round1(ticksUntilPipe),
                birdRelativeToCenter
            },
            windowTicks: physics.HORIZON,
            plans: {}
        };

        if (state.pipes[1]) {
            const pipe1 = state.pipes[1];
            const center1 = (pipe1.gapTop + pipe1.gapBottom) / 2;
            jevState.followingGap = {
                center: round1(center1),
                pipeLeftEdgeDistance: round1(pipe1.left - bird.x - bird.radius)
            };
        }

        for (const plan of PLANS) {
            const f = forecasts[plan];
            jevState.plans[plan] = {
                flapAtTick: f.flapAtTick,
                endY: round1(f.endY),
                endVelocity: round1(f.endVelocity),
                offsetFromGapCenterAtEnd: f.offsetFromGapCenterAtEnd === null ? null : round1(f.offsetFromGapCenterAtEnd),
                minClearancePx: round1(f.minClearance),
                collisionWithinWindow: describeCollision(f.collisionWithinWindow),
                ifCoastingAfterWindow: {
                    collision: describeCollision(f.collisionIfCoastingAfter),
                    passesGap: f.passesGapIfCoastingAfter
                }
            };
        }
        return jevState;
    }

    function buildRequest(state, model = 'jev-latest') {
        return { model, state: buildJevState(state), questions: { plan: question } };
    }

    function parseResponse(data) {
        const answer = data?.answers?.plan;
        const isProbability = v => Number.isFinite(v) && v >= 0 && v <= 1;
        if (!answer || answer.type !== 'choice' || !PLANS.includes(answer.choice) ||
            !isProbability(answer.confidence) || !answer.probabilities || typeof answer.probabilities !== 'object') {
            throw new Error('Invalid Jev response');
        }
        let sum = 0;
        for (const plan of PLANS) {
            const value = answer.probabilities[plan];
            if (!isProbability(value)) throw new Error('Invalid Jev response');
            sum += value;
        }
        if (Math.abs(sum - 1) > 0.02) throw new Error('Invalid Jev response');
        return {
            plan: answer.choice,
            probabilities: answer.probabilities,
            confidence: answer.confidence,
            model: data.model,
            usage: data.usage && Number.isFinite(data.usage.input_tokens) && Number.isFinite(data.usage.output_tokens)
                ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
                : { input_tokens: 0, output_tokens: 0 }
        };
    }

    const api = { PLANS, buildRequest, parseResponse };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JevContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
