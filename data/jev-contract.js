// Builds the TypeSafe request (JevState + Choice question) and validates its response.
(function (root) {
    const physics = typeof module !== 'undefined' && module.exports ? require('./jev-physics') : root.JevPhysics;
    const PLANS = physics.PLANS;

    // Plain-language contract. Jev is a System One model: it judges short, concrete
    // descriptions well and must not be asked to do arithmetic over tick tables.
    // Code does all the physics; the state says where the hole is, what three rays from
    // the bird touch, and what each option leads to.
    const question = {
        type: 'choice',
        instructions:
            'Pick the option that keeps you alive and gets you level with the hole. Never pick an option that says CRASH. ' +
            'If the hole is above you, pick an option that climbs; if it is below you, let yourself fall. ' +
            'Being too low is worse than being too high because you keep falling. Each option says exactly where you end up.',
        criteria: {
            no_flap: 'Do nothing and fall.',
            flap_now: 'One flap right now.',
            flap_at_8: 'One flap a little later.',
            flap_at_16: 'One flap late in the step.',
            double_flap: 'Two flaps: climb.',
            triple_flap: 'Three flaps: climb fast.'
        }
    };

    const CRASH_NAMES = { 'top pipe': 'the top pipe', 'bottom pipe': 'the bottom pipe', ground: 'the ground' };

    function px(n) { return `${Math.round(Math.abs(n))} px`; }

    function describeOffset(offset) {
        const a = Math.abs(offset);
        if (a < 10) return 'level with the hole';
        const side = offset > 0 ? 'too low' : 'too high';
        if (a < 30) return `slightly ${side}`;
        if (a < 80) return `${side} by ${px(offset)}`;
        return `far ${side} by ${px(offset)}`;
    }

    function describeOption(f) {
        if (f.collisionWithinWindow) return `CRASH into ${CRASH_NAMES[f.collisionWithinWindow.with]}.`;
        const after = f.collisionIfCoastingAfter
            ? `, then crashes into ${CRASH_NAMES[f.collisionIfCoastingAfter.with]} if nothing more is done`
            : '';
        return `Safe: ${describeOffset(f.offsetFromGapCenterAtEnd)}${after}.`;
    }

    // Three rays from the bird toward the next pipe: straight ahead, ahead-and-up (45 deg),
    // ahead-and-down (45 deg). Each reports the first thing it touches.
    function castRay(state, dy) {
        const bird = state.bird;
        const pipe = state.pipes[0];
        const groundY = state.world.groundY;
        for (let step = 1; step <= 400; step += 2) {
            const x = bird.x + step;
            const y = bird.y + step * dy;
            if (y >= groundY) return 'the ground';
            if (y < 0) return 'the sky (too high, nothing there)';
            if (x >= pipe.left && x <= pipe.right) {
                if (y <= pipe.gapTop) return 'the top pipe';
                if (y >= pipe.gapBottom) return 'the bottom pipe';
                return 'the hole - it goes through';
            }
            if (x > pipe.right) return 'the hole - it goes through';
        }
        return 'nothing yet (pipe is far)';
    }

    function describeNow(state) {
        const bird = state.bird;
        const pipe = state.pipes[0];
        const gapCenter = (pipe.gapTop + pipe.gapBottom) / 2;
        const diff = bird.y - gapCenter;
        const motion = bird.velocity < -0.5 ? 'rising' : bird.velocity > 0.5 ? 'falling' : 'level';
        const hole = Math.abs(diff) < 10 ? 'The hole is straight ahead at your height.'
            : `The hole is ${diff > 0 ? 'ABOVE' : 'BELOW'} you by ${px(diff)}.`;
        const distance = pipe.left - bird.x - bird.radius;
        let pipeText;
        if (distance <= 0) pipeText = 'You are inside the pipe right now.';
        else {
            const secs = Math.round(distance / state.physics.pipeSpeed / 60 * 10) / 10;
            pipeText = secs > 1 ? `The pipe is far (about ${secs} s away).`
                : secs > 0.4 ? `The pipe is close (about ${secs} s away).`
                : `The pipe is right ahead (about ${secs} s away).`;
        }
        let following = '';
        if (state.pipes[1]) {
            const c2 = (state.pipes[1].gapTop + state.pipes[1].gapBottom) / 2;
            const d = c2 - gapCenter;
            following = Math.abs(d) < 10 ? ' The hole after that is at the same height.'
                : ` The hole after that is ${px(d)} ${d > 0 ? 'lower' : 'higher'}.`;
        }
        return `You are ${motion}. ${hole} ${pipeText}${following}`;
    }

    function buildJevState(state) {
        const forecasts = physics.forecastPlans(state);
        const options = {};
        for (const plan of PLANS) options[plan] = describeOption(forecasts[plan]);
        return {
            game: 'You are the bird in Flappy Bird. Fly through the hole between the top pipe and the bottom pipe. Touching a pipe or the ground kills you.',
            now: describeNow(state),
            rays: {
                'straight ahead': castRay(state, 0),
                'ahead and up': castRay(state, -1),
                'ahead and down': castRay(state, 1)
            },
            options
        };
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
