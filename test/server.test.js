const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const state = {
    bird: { x: 100, y: 200, velocity: 2, collisionRadius: 15 },
    world: { width: 450, groundY: 750 },
    physics: { gravity: 0.4, jumpPower: 6, pipeSpeed: 2 },
    decisionFrames: 6, pipes: [{ left: 160, right: 210, gapTop: 160, gapBottom: 285 }]
};
const answer = action => ({ model: 'jev-test', answers: { action: {
    type: 'choice', choice: action, confidence: 0.8, probabilities: { flap: 0.9, coast: 0.1 }
} } });
async function app(t, options) {
    const server = createServer({ minIntervalMs: 0, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, post: (payload = { state }, headers = {}) => fetch(base + '/api/jev/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
    }) };
}
test('browser key overrides server key; state and choice contract reach TypeSafe', async t => {
    let sent;
    const { post } = await app(t, { apiKey: 'server-secret', fetchImpl: async (url, options) => {
        sent = { url, ...options }; return Response.json(answer('flap'));
    } });
    const response = await post({ state, apiKey: 'browser-secret' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).action, 'flap');
    assert.equal(sent.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(sent.headers.Authorization, 'Bearer browser-secret');
    const body = JSON.parse(sent.body);
    const { analysis, ...observed } = body.state;
    assert.deepEqual(observed, state);
    assert.equal(analysis.motion, "falling or stationary");
    assert.ok(Number.isFinite(analysis.flap.minY));
    assert.equal(body.questions.action.type, 'choice');
    assert.deepEqual(Object.keys(body.questions.action.criteria), ['flap', 'coast']);
    assert.ok(!sent.body.includes('secret'));
});
test('server key works when browser key is empty', async t => {
    const { post } = await app(t, { apiKey: 'server-secret', fetchImpl: async (_, options) => {
        assert.equal(options.headers.Authorization, 'Bearer server-secret');
        return Response.json(answer('coast'));
    } });
    assert.equal((await (await post({ state, apiKey: '' })).json()).action, 'coast');
});
test('missing key, malformed state, foreign origin and private files are rejected', async t => {
    let calls = 0;
    const { post, base } = await app(t, { apiKey: '', fetchImpl: () => calls++ });
    assert.equal((await post()).status, 503);
    assert.equal((await post({ state: {}, apiKey: 'key' })).status, 400);
    assert.equal((await post({ state, apiKey: 'key' }, { Origin: 'https://example.com' })).status, 403);
    for (const file of ['.env', '.git/config', 'server.js', 'data/%2e%2e%5c.env']) {
        assert.equal((await fetch(base + '/' + file)).status, 404);
    }
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/data/scenes/watch-scene.js')).status, 200);
    assert.equal(calls, 0);
});
test('invalid model output and auth errors stop without a fallback decision', async t => {
    let response = Response.json(answer('jump'));
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => response });
    assert.equal((await post()).status, 502);
    response = new Response('do not leak upstream body', { status: 401 });
    const result = await post();
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes('do not leak'));
});
test('rate limits establish cooldown instead of repeatedly spending requests', async t => {
    let calls = 0;
    const { post } = await app(t, { apiKey: 'key', fetchImpl: async () => {
        calls++; return new Response('', { status: 429, headers: { 'retry-after': '10' } });
    } });
    assert.equal((await post()).status, 502);
    assert.equal((await post()).status, 429);
    assert.equal(calls, 1);
});
test('timeout cancels upstream and releases request slot', async t => {
    const { post } = await app(t, { apiKey: 'key', timeoutMs: 10, fetchImpl: (_, { signal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    const result = await post();
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /timed out/);
    assert.equal((await post()).status, 502);
});

test('server caps billed attempts even on failures', async t => {
    let calls = 0;
    const { post } = await app(t, { apiKey: 'key', maxCalls: 2, fetchImpl: async () => {
        calls++; return new Response('', { status: 401 });
    } });
    await post(); await post();
    assert.equal((await post()).status, 429);
    assert.equal(calls, 2);
});
test('server enforces minimum spacing', async t => {
    let calls = 0;
    const { post } = await app(t, { apiKey: 'key', minIntervalMs: 1000, fetchImpl: async () => {
        calls++; return Response.json(answer('coast'));
    } });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 429);
    assert.equal(calls, 1);
});
