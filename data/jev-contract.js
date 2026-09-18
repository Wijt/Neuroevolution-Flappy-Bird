// Builds the TypeSafe request (pure sensor state + three questions) and validates its
// response, composing the flap plan in code from Jev's judgments.
(function (root) {
    const physics = typeof module !== 'undefined' && module.exports ? require('./jev-physics') : root.JevPhysics;
    const PLANS = physics.PLANS;

    // v3: pure sensor mode. Jev is a System One model; it perceives short concrete
    // descriptions and judges them. Nothing about option outcomes reaches the model -
    // no "Safe", no "CRASH", no bucketed offsets. Code composes the plan afterwards.
    const questions = {
        danger: {
            type: 'noul',
            instructions: 'Will you hit the bottom pipe or the ground within the next half second unless you flap?'
        },
        climb: {
            type: 'choice',
            instructions:
                'How much height do you need to gain in the next 0.4 seconds? Choose by where the hole is and how you are moving. ' +
                'If the hole is below you or you are rising above it, do not flap. Being too low is worse than being too high because you keep falling.',
            criteria: {
                none: 'No flap. You keep falling (or keep rising if you were rising).',
                one_flap: 'One flap. A small push: roughly holds your height over the step.',
                two_flaps: 'Two flaps. A steady climb of about 60 px.',
                three_flaps: 'Three flaps. The fastest climb, about 100 px.'
            }
        },
        timing: {
            type: 'choice',
            instructions:
                'If you flap only once in the next 0.4 seconds, when should it be? Flap sooner when you are falling fast or the pipe is close; later when you have room.',
            criteria: {
                now: 'Flap immediately.',
                soon: 'Wait a moment (about 0.13 s), then flap.',
                late: 'Wait longer (about 0.27 s), then flap.'
            }
        }
    };

    const TIMING_TO_PLAN = { now: 'flap_now', soon: 'flap_at_8', late: 'flap_at_16' };

    // Code composes the plan; danger is not used for control in pure mode, only shown
    // in the console and logged.
    function composePlan(answers) {
        const climb = answers.climb.choice;
        if (climb === 'none') return 'no_flap';
        if (climb === 'two_flaps') return 'double_flap';
        if (climb === 'three_flaps') return 'triple_flap';
        if (climb === 'one_flap') return TIMING_TO_PLAN[answers.timing.choice] || 'flap_now';
        return 'no_flap';
    }

    function px(n) { return `${Math.round(Math.abs(n))} px`; }

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

    function motionWord(velocity) {
        return velocity < -0.5 ? 'rising' : velocity > 0.5 ? 'falling' : 'level';
    }

    function describeHole(diff) {
        if (Math.abs(diff) < 10) return 'straight ahead at your height';
        return `${diff > 0 ? 'ABOVE' : 'BELOW'} you by ${px(diff)}`;
    }

    function describePipe(state) {
        const bird = state.bird;
        const pipe = state.pipes[0];
        const distance = pipe.left - bird.x - bird.radius;
        if (distance <= 0) return 'you are inside the pipe right now';
        const secs = Math.round(distance / state.physics.pipeSpeed / 60 * 10) / 10;
        if (secs > 1) return `far (about ${secs} s away)`;
        if (secs > 0.4) return `close (about ${secs} s away)`;
        return `right ahead (about ${secs} s away)`;
    }

    function describeNextHole(gapCenter, nextPipe) {
        const c2 = (nextPipe.gapTop + nextPipe.gapBottom) / 2;
        const d = c2 - gapCenter;
        if (Math.abs(d) < 10) return 'at the same height';
        return `${px(d)} ${d > 0 ? 'lower' : 'higher'} than this one`;
    }

    // Perception only: where the hole is, how the bird is moving, how far the pipe is
    // and what three rays touch. No option outcomes, no tick jargon.
    function buildSensorState(state) {
        const bird = state.bird;
        const pipe = state.pipes[0];
        const gapCenter = (pipe.gapTop + pipe.gapBottom) / 2;
        const diff = bird.y - gapCenter;
        const sensorState = {
            game: 'You are the bird in Flappy Bird. Fly through the hole between the top pipe and the bottom pipe. Touching a pipe or the ground kills you. You fall all the time; a flap gives one push upward.',
            you: motionWord(bird.velocity),
            hole: describeHole(diff),
            pipe: describePipe(state),
            rays: {
                'straight ahead': castRay(state, 0),
                'ahead and up': castRay(state, -1),
                'ahead and down': castRay(state, 1)
            }
        };
        if (state.pipes[1]) sensorState.next_hole = describeNextHole(gapCenter, state.pipes[1]);
        return sensorState;
    }

    function buildRequest(state, model = 'jev-latest') {
        return { model, state: buildSensorState(state), questions };
    }

    function isProbability(v) { return Number.isFinite(v) && v >= 0 && v <= 1; }

    function validateChoiceAnswer(answer, keys) {
        if (!answer || answer.type !== 'choice' || !keys.includes(answer.choice) ||
            !answer.probabilities || typeof answer.probabilities !== 'object' ||
            !isProbability(answer.confidence)) {
            throw new Error('Invalid Jev response');
        }
        let sum = 0;
        const probabilities = {};
        for (const key of keys) {
            const value = answer.probabilities[key];
            if (!isProbability(value)) throw new Error('Invalid Jev response');
            probabilities[key] = value;
            sum += value;
        }
        if (Math.abs(sum - 1) > 0.02) throw new Error('Invalid Jev response');
        return { choice: answer.choice, probabilities, confidence: answer.confidence };
    }

    function parseResponse(data) {
        const rawAnswers = data && data.answers;
        if (!rawAnswers || typeof rawAnswers !== 'object') throw new Error('Invalid Jev response');

        const dangerAnswer = rawAnswers.danger;
        if (!dangerAnswer || dangerAnswer.type !== 'noul' || !isProbability(dangerAnswer.noul)) {
            throw new Error('Invalid Jev response');
        }

        const climb = validateChoiceAnswer(rawAnswers.climb, Object.keys(questions.climb.criteria));
        const timing = validateChoiceAnswer(rawAnswers.timing, Object.keys(questions.timing.criteria));

        const answers = { danger: { noul: dangerAnswer.noul }, climb, timing };
        return {
            answers,
            plan: composePlan(answers),
            model: data.model,
            usage: data.usage && Number.isFinite(data.usage.input_tokens) && Number.isFinite(data.usage.output_tokens)
                ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
                : { input_tokens: 0, output_tokens: 0 }
        };
    }

    const api = { PLANS, questions, buildRequest, parseResponse, composePlan };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JevContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
