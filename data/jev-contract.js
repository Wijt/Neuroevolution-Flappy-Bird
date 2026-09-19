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
                'How many flaps do you need in the next 0.4 seconds? Look at where the hole is and whether you are rising or falling. ' +
                'You always fall unless you flap, and one flap only lifts you a little. Too many flaps overshoot into the top pipe; ' +
                'too few drop you into the bottom pipe. If you are rising, you usually need nothing.',
            criteria: {
                none: 'The hole is below you, or you are rising and already above the hole. No flap needed.',
                one_flap: 'You are falling and the hole is at your height or up to about 60 px above you.',
                two_flaps: 'The hole is clearly above you (about 60 to 120 px), or a little above you and you are falling fast.',
                three_flaps: 'The hole is far above you (more than about 120 px), or you are falling fast toward the bottom pipe or the ground.'
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

    const FLAPS_OF = { none: 0, one_flap: 1, two_flaps: 2, three_flaps: 3 };
    const DANGER_FLOOR = 0.8;
    const PLAN_OF_FLAPS = { 0: 'no_flap', 2: 'double_flap', 3: 'triple_flap' };

    // Expected number of flaps under Jev's whole distribution (probability-weighted), not
    // just the argmax. A 55/34/8/2 split over none/one/two/three means 0.56 flaps: one flap,
    // where the argmax would say none. Falls back to the chosen option when there is no
    // distribution (tests, older payloads).
    function expectedFlaps(climb) {
        const p = climb && climb.probabilities;
        if (!p) return FLAPS_OF[climb && climb.choice] || 0;
        let e = 0;
        for (const key in FLAPS_OF) e += (p[key] || 0) * FLAPS_OF[key];
        return e;
    }

    // Code composes the plan from Jev's judgments. Policy, explicit and in one place:
    //  - flaps = expected flaps rounded to the nearest whole number;
    //  - if Jev is clearly sure about danger (>= 0.8) and the rounding gave zero flaps, flap
    //    once anyway. Live data showed danger sits at 0.45-0.79 for any falling bird, so a
    //    0.6 floor over-flapped into the top pipe; 0.8 only fires on a real alarm.
    // Nothing here looks at physics; only Jev's answers.
    function composePlan(answers) {
        let flaps = Math.round(expectedFlaps(answers.climb));
        const danger = answers.danger && Number.isFinite(answers.danger.noul) ? answers.danger.noul : 0;
        if (flaps === 0 && danger >= DANGER_FLOOR) flaps = 1;
        flaps = Math.max(0, Math.min(3, flaps));
        if (flaps === 1) return TIMING_TO_PLAN[answers.timing && answers.timing.choice] || 'flap_now';
        return PLAN_OF_FLAPS[flaps];
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

    // Direction plus how fast: at gravity 0.4 px/tick^2 a flap sets -6, so |v| > 4 is fast.
    function motionWord(velocity) {
        const speed = Math.abs(velocity);
        if (speed <= 0.5) return 'level (not moving up or down)';
        const dir = velocity < 0 ? 'rising' : 'falling';
        return speed > 4 ? `${dir} fast` : speed > 1.5 ? dir : `${dir} slowly`;
    }

    // Where the hole's middle is, plus both edges, so the model can see when the top
    // pipe is close as well as the bottom one (a player sees both edges).
    function describeHole(diff, pipe, birdY) {
        const topEdge = birdY - pipe.gapTop;       // positive: top edge is above you
        const bottomEdge = pipe.gapBottom - birdY; // positive: bottom edge is below you
        const edge = (d, up) => d >= 0 ? `${px(d)} ${up ? 'above' : 'below'} you` : `${px(d)} ${up ? 'below' : 'above'} you`;
        const edges = ` (top edge ${edge(topEdge, true)}, bottom edge ${edge(bottomEdge, false)})`;
        if (Math.abs(diff) < 10) return 'straight ahead at your height' + edges;
        return `${diff > 0 ? 'ABOVE' : 'BELOW'} you by ${px(diff)}` + edges;
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
    const GAME_TEXT = 'You are the bird in Flappy Bird. Fly through the hole between the top pipe and the bottom pipe. Touching a pipe or the ground kills you. You fall all the time; a flap gives one push upward.';

    // Everything a person may rewrite from the console: the game sentence, each
    // question's instructions and each criterion's text. Keys (question ids, option
    // names) are fixed because code composes the plan from them.
    function defaultPrompts() {
        const out = { game: GAME_TEXT, questions: {} };
        for (const id in questions) {
            const q = questions[id];
            out.questions[id] = { instructions: q.instructions };
            if (q.criteria) out.questions[id].criteria = Object.assign({}, q.criteria);
        }
        return out;
    }

    const MAX_PROMPT_CHARS = 1500;
    function cleanText(v, fallback) {
        if (typeof v !== 'string') return fallback;
        const t = v.trim();
        if (!t || t.length > MAX_PROMPT_CHARS) return fallback;
        return t;
    }

    // Merge user overrides onto the defaults, accepting only known keys and strings.
    // Unknown or malformed parts fall back to the default text; never throws.
    function resolvePrompts(overrides) {
        const base = defaultPrompts();
        if (!overrides || typeof overrides !== 'object') return base;
        base.game = cleanText(overrides.game, base.game);
        const oq = overrides.questions && typeof overrides.questions === 'object' ? overrides.questions : {};
        for (const id in base.questions) {
            const o = oq[id];
            if (!o || typeof o !== 'object') continue;
            base.questions[id].instructions = cleanText(o.instructions, base.questions[id].instructions);
            if (base.questions[id].criteria && o.criteria && typeof o.criteria === 'object') {
                for (const key in base.questions[id].criteria) {
                    base.questions[id].criteria[key] = cleanText(o.criteria[key], base.questions[id].criteria[key]);
                }
            }
        }
        return base;
    }

    function buildQuestions(prompts) {
        const out = {};
        for (const id in questions) {
            out[id] = { type: questions[id].type, instructions: prompts.questions[id].instructions };
            if (questions[id].criteria) out[id].criteria = prompts.questions[id].criteria;
        }
        return out;
    }

    function buildSensorState(state, gameText = GAME_TEXT) {
        const bird = state.bird;
        const pipe = state.pipes[0];
        const gapCenter = (pipe.gapTop + pipe.gapBottom) / 2;
        const diff = bird.y - gapCenter;
        const sensorState = {
            game: gameText,
            you: motionWord(bird.velocity),
            hole: describeHole(diff, pipe, bird.y),
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

    // `prompts` (optional) carries console-edited texts; see resolvePrompts.
    function buildRequest(state, model = 'jev-latest', prompts = null) {
        const resolved = resolvePrompts(prompts);
        return { model, state: buildSensorState(state, resolved.game), questions: buildQuestions(resolved) };
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

        climb.expectedFlaps = Math.round(expectedFlaps(climb) * 100) / 100;
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

    const api = { PLANS, questions, buildRequest, parseResponse, composePlan, expectedFlaps, defaultPrompts, resolvePrompts };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JevContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
