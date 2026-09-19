// Builds the TypeSafe request (pure sensor state + three yes/no questions) and validates
// its response, composing the flap plan in code from Jev's judgments with one threshold.
(function (root) {
    const physics = typeof module !== 'undefined' && module.exports ? require('./jev-physics') : root.JevPhysics;
    const PLANS = physics.PLANS;

    // v3: pure sensor mode. Jev is a System One model; it perceives short concrete
    // descriptions and judges them. Nothing about option outcomes reaches the model -
    // no "Safe", no "CRASH", no bucketed offsets. Code composes the plan afterwards.
    const questions = {
        flap_now: {
            type: 'noul',
            instructions:
                'Should you flap right now? Flap when the hole is above you or you are falling toward the bottom pipe or the ground. ' +
                'Do not flap when the hole is below you or you are rising above it. One flap is a small push upward.'
        },
        flap_again: {
            type: 'noul',
            instructions:
                'Suppose you flap right now. Should you flap a second time 0.2 seconds later, to climb faster? ' +
                'Yes only if the hole is well above you or you are falling fast; two flaps in a row climb a lot.'
        },
        flap_later: {
            type: 'noul',
            instructions:
                'Suppose you do NOT flap right now. Should you flap 0.2 seconds later instead? ' +
                'Yes if you are only slightly below the hole or will start falling toward it soon.'
        }
    };

    const DEFAULT_THRESHOLD = 0.5;

    // Code composes the plan from three yes/no judgments with ONE threshold:
    //   flap_now >= T  and flap_again >= T  -> double_flap  (ticks 0 and 12)
    //   flap_now >= T  and flap_again <  T  -> flap_now     (tick 0)
    //   flap_now <  T  and flap_later >= T  -> flap_at_12   (tick 12)
    //   otherwise                            -> no_flap
    function composePlan(answers, threshold = DEFAULT_THRESHOLD) {
        const T = Number.isFinite(threshold) ? Math.min(0.99, Math.max(0.01, threshold)) : DEFAULT_THRESHOLD;
        const p = id => (answers && answers[id] && Number.isFinite(answers[id].noul)) ? answers[id].noul : 0;
        if (p('flap_now') >= T) return p('flap_again') >= T ? 'double_flap' : 'flap_now';
        return p('flap_later') >= T ? 'flap_at_12' : 'no_flap';
    }

    function px(n) { return `${Math.round(Math.abs(n))} px`; }

    // Three rays from the bird toward the next pipe: straight ahead, ahead-and-up (45 deg),
    // ahead-and-down (45 deg). Each reports the first thing it touches and where.
    function castRayHit(state, dy) {
        const bird = state.bird;
        const pipe = state.pipes[0];
        const groundY = state.world.groundY;
        let x = bird.x, y = bird.y;
        for (let step = 1; step <= 400; step += 2) {
            x = bird.x + step;
            y = bird.y + step * dy;
            if (y >= groundY) return { hit: 'the ground', x, y: groundY };
            if (y < 0) return { hit: 'the sky (too high, nothing there)', x, y: 0 };
            if (x >= pipe.left && x <= pipe.right) {
                if (y <= pipe.gapTop) return { hit: 'the top pipe', x, y };
                if (y >= pipe.gapBottom) return { hit: 'the bottom pipe', x, y };
                return { hit: 'the hole - it goes through', x, y };
            }
            if (x > pipe.right) return { hit: 'the hole - it goes through', x, y };
        }
        return { hit: 'nothing yet (pipe is far)', x, y };
    }
    function castRay(state, dy) { return castRayHit(state, dy).hit; }

    // For the canvas overlay: [{ name, x, y, hit }] from the bird's position.
    function rayHits(state) {
        return [
            Object.assign({ name: 'straight ahead' }, castRayHit(state, 0)),
            Object.assign({ name: 'ahead and up' }, castRayHit(state, -1)),
            Object.assign({ name: 'ahead and down' }, castRayHit(state, 1))
        ];
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

    function parseResponse(data, threshold = DEFAULT_THRESHOLD) {
        const rawAnswers = data && data.answers;
        if (!rawAnswers || typeof rawAnswers !== 'object') throw new Error('Invalid Jev response');
        const answers = {};
        for (const id in questions) {
            const answer = rawAnswers[id];
            if (!answer || answer.type !== 'noul' || !isProbability(answer.noul)) throw new Error('Invalid Jev response');
            answers[id] = { noul: answer.noul };
        }
        return {
            answers,
            plan: composePlan(answers, threshold),
            model: data.model,
            usage: data.usage && Number.isFinite(data.usage.input_tokens) && Number.isFinite(data.usage.output_tokens)
                ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
                : { input_tokens: 0, output_tokens: 0 }
        };
    }

    const api = { PLANS, questions, DEFAULT_THRESHOLD, buildRequest, parseResponse, composePlan, rayHits, defaultPrompts, resolvePrompts };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.JevContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
