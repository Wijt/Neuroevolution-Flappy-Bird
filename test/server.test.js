const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

const state = {
    bird: { x: 100, y: 300, velocity: 2, radius: 15 },
    world: { width: 450, groundY: 750 },
    physics: { gravity: 0.4, jumpPower: 6, pipeSpeed: 2 },
    pipes: [{ left: 400, right: 450, gapTop: 260, gapBottom: 385 }]
};

// v4: three yes/no judgments composed with one threshold (default 0.5).
//   flap_now >= T && flap_again >= T -> double_flap
//   flap_now >= T                    -> flap_now
//   flap_later >= T                  -> flap_at_12
//   otherwise                        -> no_flap
const PLAN_ANSWERS = {
    no_flap: { flap_now: 0.1, flap_again: 0.1, flap_later: 0.1 },
    flap_now: { flap_now: 0.9, flap_again: 0.1, flap_later: 0.1 },
    flap_at_12: { flap_now: 0.1, flap_again: 0.1, flap_later: 0.9 },
    double_flap: { flap_now: 0.9, flap_again: 0.9, flap_later: 0.1 }
};

const answer = plan => {
    const p = PLAN_ANSWERS[plan] || PLAN_ANSWERS.no_flap;
    return {
        model: 'jev-test',
        usage: { input_tokens: 500, output_tokens: 8 },
        answers: {
            flap_now: { type: 'noul', noul: p.flap_now },
            flap_again: { type: 'noul', noul: p.flap_again },
            flap_later: { type: 'noul', noul: p.flap_later }
        }
    };
};

async function app(t, options) {
    const server = createServer(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base,
        post: (payload = { id: 1, state }, headers = {}) => fetch(base + '/api/jev/decide', {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
        })
    };
}

test('browser key overrides server key; request/response contract reaches TypeSafe', async t => {
    let sent;
    const { post } = await app(t, {
        apiKey: 'server-secret', fetchImpl: async (url, options) => {
            sent = { url, ...options };
            return Response.json(answer('flap_now'));
        }
    });
    const response = await post({ id: 42, state, apiKey: 'browser-secret' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, 42);
    assert.equal(body.plan, 'flap_now');
    assert.equal(body.answers.flap_now.noul, 0.9);
    assert.equal(body.threshold, 0.5);
    assert.deepEqual(body.usage, { input_tokens: 500, output_tokens: 8 });
    assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(sent.headers.Authorization, 'Bearer browser-secret');
    assert.ok(!sent.body.includes('secret'));
    const sentRequest = JSON.parse(sent.body);
    assert.equal(sentRequest.questions.flap_now.type, 'noul');
    assert.equal(sentRequest.questions.flap_again.type, 'noul');
    assert.equal(sentRequest.questions.flap_later.type, 'noul');
});

test('server key works when browser key is empty', async t => {
    const { post } = await app(t, {
        apiKey: 'server-secret', fetchImpl: async (_, options) => {
            assert.equal(options.headers.Authorization, 'Bearer server-secret');
            return Response.json(answer('no_flap'));
        }
    });
    assert.equal((await (await post({ id: 1, state, apiKey: '' })).json()).plan, 'no_flap');
});

test('missing key returns 503', async t => {
    const { post } = await app(t, { apiKey: '', fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal((await post({ id: 1, state, apiKey: '' })).status, 503);
});

test('invalid game state returns 400', async t => {
    const { post } = await app(t, { apiKey: 'key', fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal((await post({ id: 1, state: {} })).status, 400);
    const badPipes = { ...state, pipes: [] };
    assert.equal((await post({ id: 1, state: badPipes })).status, 400);
    const badPhysics = { ...state, physics: { gravity: 1, jumpPower: 6, pipeSpeed: 2 } };
    assert.equal((await post({ id: 1, state: badPhysics })).status, 400);
});

test('foreign origin is rejected; static files serve only index.html and data/**', async t => {
    const { post, base } = await app(t, { apiKey: 'key', fetchImpl: () => { throw new Error('should not be called'); } });
    assert.equal((await post({ id: 1, state }, { Origin: 'https://example.com' })).status, 403);
    for (const file of ['.env', '.git/config', 'server.js', 'data/%2e%2e%5c.env']) {
        assert.equal((await fetch(base + '/' + file)).status, 404);
    }
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/data/jev-physics.js')).status, 200);
});

test('upstream 401 maps to 401 without leaking the upstream body', async t => {
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => new Response('do not leak this body', { status: 401 }) });
    const result = await post();
    assert.equal(result.status, 401);
    assert.ok(!(await result.text()).includes('do not leak'));
});

test('upstream 429 maps to 429 and honours retry-after', async t => {
    const { post } = await app(t, {
        apiKey: 'key', fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '7' } })
    });
    const result = await post();
    assert.equal(result.status, 429);
    assert.equal((await result.json()).retryAfterMs, 7000);
});

test('upstream 529 without retry-after defaults to 2000ms', async t => {
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => new Response('', { status: 529 }) });
    const result = await post();
    assert.equal(result.status, 429);
    assert.equal((await result.json()).retryAfterMs, 2000);
});

test('other upstream errors map to 502', async t => {
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => new Response('', { status: 500 }) });
    assert.equal((await post()).status, 502);
});

test('an invalid model answer maps to 502', async t => {
    const bad = answer('flap_now');
    bad.answers.flap_now = { type: 'choice', noul: 0.9 }; // wrong type for a noul question
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => Response.json(bad) });
    assert.equal((await post()).status, 502);
});

test('client timeout aborts upstream and maps to 502', async t => {
    const { post } = await app(t, {
        apiKey: 'key', timeoutMs: 10, fetchImpl: (_, { signal }) =>
            new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    });
    const result = await post();
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /timed out/);
});

test('per-key in-flight limit returns 429 while requests are outstanding', async t => {
    let release;
    const { post } = await app(t, {
        apiKey: 'key', maxInFlightPerKey: 1,
        fetchImpl: () => new Promise(resolve => { release = resolve; })
    });
    const first = post();
    await new Promise(r => setImmediate(r));
    const second = await post();
    assert.equal(second.status, 429);
    release(Response.json(answer('no_flap')));
    assert.equal((await first).status, 200);
});

test('per-minute limit returns 429 once exceeded', async t => {
    let calls = 0;
    const { post } = await app(t, {
        apiKey: 'key', maxRequestsPerMinutePerKey: 2,
        fetchImpl: async () => { calls++; return Response.json(answer('no_flap')); }
    });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 429);
    assert.equal(calls, 2);
});

test('the API key is never present in the body sent upstream', async t => {
    let sentBody;
    const { post } = await app(t, {
        apiKey: 'server-secret', fetchImpl: async (_, options) => { sentBody = options.body; return Response.json(answer('no_flap')); }
    });
    await post({ id: 1, state, apiKey: 'browser-secret-value' });
    assert.ok(!sentBody.includes('browser-secret-value'));
    assert.ok(!sentBody.includes('server-secret'));
});

test('console prompts reach TypeSafe; unknown keys are dropped', async t => {
    let sent;
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async (url, options) => {
        sent = JSON.parse(options.body); return Response.json(answer('no_flap'));
    } });
    const response = await post({ id: 1, state, apiKey: '', prompts: { game: 'Custom game text.', questions: { flap_now: { instructions: 'Custom flap now?' }, nope: {} } } });
    assert.equal(response.status, 200);
    assert.equal(sent.state.game, 'Custom game text.');
    assert.equal(sent.questions.flap_now.instructions, 'Custom flap now?');
    assert.equal(sent.questions.nope, undefined);
});

test('threshold defaults to 0.5 when omitted and is echoed back', async t => {
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => Response.json(answer('flap_now')) });
    const body = await (await post({ id: 1, state })).json();
    assert.equal(body.threshold, 0.5);
});

test('threshold is forwarded and used to compose the plan', async t => {
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => Response.json(answer('flap_now')) });
    // answer('flap_now') has flap_now=0.9, flap_again=0.1, flap_later=0.1.
    // At threshold 0.95 flap_now no longer clears the bar, and flap_later doesn't either.
    const body = await (await post({ id: 1, state, threshold: 0.95 })).json();
    assert.equal(body.threshold, 0.95);
    assert.equal(body.plan, 'no_flap');
});

test('threshold is clamped to [0.01, 0.99]', async t => {
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => Response.json(answer('flap_now')) });
    const low = await (await post({ id: 1, state, threshold: -5 })).json();
    assert.equal(low.threshold, 0.01);
    const high = await (await post({ id: 1, state, threshold: 5 })).json();
    assert.equal(high.threshold, 0.99);
    const notFinite = await (await post({ id: 1, state, threshold: 'nope' })).json();
    assert.equal(notFinite.threshold, 0.5);
});
