const http = require('node:http');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const { ACTION_FRAMES, buildRequest } = require('./data/jev-contract');

function validateState(state) {
    const number = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
    return state && number(state.bird?.x, 0, 10000) && number(state.bird?.y, -100, 10000) &&
        number(state.bird?.velocity, -100, 100) && number(state.bird?.collisionRadius, 1, 100) &&
        number(state.world?.width, 100, 10000) && number(state.world?.groundY, 100, 10000) &&
        state.physics?.gravity === 0.4 && state.physics?.jumpPower === 6 && state.physics?.pipeSpeed === 2 &&
        state.decisionFrames === ACTION_FRAMES && Array.isArray(state.pipes) && state.pipes.length <= 3 &&
        state.pipes.length > 0 && state.pipes.every(p => p &&
            number(p.left, -100, 20000) && number(p.right, p.left + 1, 20000) &&
            number(p.gapTop, 0, state.world.groundY) && number(p.gapBottom, p.gapTop + 1, state.world.groundY));
}

function parseAnswer(data) {
    const answer = data?.answers?.action;
    const probability = v => Number.isFinite(v) && v >= 0 && v <= 1;
    if (answer?.type !== 'choice' || !['flap', 'coast'].includes(answer.choice) ||
        !probability(answer.confidence) || !probability(answer.probabilities?.flap) ||
        !probability(answer.probabilities?.coast) ||
        Math.abs(answer.probabilities.flap + answer.probabilities.coast - 1) > 0.02) {
        throw new Error('Invalid Jev response');
    }
    return { action: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities,
        model: data.model, decisionFrames: ACTION_FRAMES };
}

function createServer({ apiKey = process.env.TYPESAFE_API_KEY, model = process.env.TYPESAFE_MODEL || 'jev-latest',
    fetchImpl = fetch, timeoutMs = 10000, minIntervalMs = 1000, maxCalls = 120 } = {}) {
    const accounts = new Map();
    let busy = false;
    let retryAt = 0;
    const json = (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    return http.createServer(async (req, res) => {
        try {
            const host = req.headers.host || '';
            if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
                (req.headers.origin && req.headers.origin !== `http://${host}`)) {
                return json(res, 403, { error: 'Only same-origin local requests are allowed.' });
            }
            const url = new URL(req.url, `http://${host}`);
            if (url.pathname === '/api/jev/action' && req.method === 'POST') {
                if (busy || Date.now() < retryAt) return json(res, 429, { error: 'Jev is busy. Wait a moment, then retry.' });
                if (!(req.headers['content-type'] || '').startsWith('application/json')) {
                    return json(res, 415, { error: 'Expected JSON.' });
                }
                let body = '';
                for await (const chunk of req) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 8192) return json(res, 413, { error: 'Request too large.' });
                }
                let payload;
                try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
                const state = payload?.state;
                if (payload?.apiKey != null && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 1024 || /[\r\n]/.test(payload.apiKey))) {
                    return json(res, 400, { error: 'Invalid API key.' });
                }
                const requestKey = payload?.apiKey?.trim() || apiKey;
                if (!requestKey) return json(res, 503, { error: 'Enter your TypeSafe API key above, or set TYPESAFE_API_KEY in .env.' });
                if (!validateState(state)) return json(res, 400, { error: 'Invalid game state.' });
                if (busy) return json(res, 429, { error: 'Jev is busy. Retry shortly.' });
                const keyId = createHash('sha256').update(requestKey).digest('hex');
                const account = accounts.get(keyId) || { calls: 0, lastCallAt: 0 };
                if (account.calls >= maxCalls) return json(res, 429, { error: 'Server API budget exhausted (120 attempts per key). Restart server deliberately to renew.' });
                if (Date.now() - account.lastCallAt < minIntervalMs) return json(res, 429, { error: 'Call spacing limit. Wait one second before retrying.' });
                account.calls++;
                account.lastCallAt = Date.now();
                accounts.set(keyId, account);
                busy = true;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                const cancel = () => { if (!res.writableEnded) controller.abort(); };
                res.on('close', cancel);
                const started = Date.now();
                try {
                    const request = buildRequest(state, model);
                    const upstream = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
                        method: 'POST', signal: controller.signal,
                        headers: { Authorization: `Bearer ${requestKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(request)
                    });
                    if (!upstream.ok) {
                        if ([429, 529].includes(upstream.status)) {
                            const seconds = Number(upstream.headers.get('retry-after'));
                            retryAt = Date.now() + Math.max(5000, Number.isFinite(seconds) ? seconds * 1000 : 5000);
                        }
                        const error = upstream.status === 401 ? 'TypeSafe rejected the API key. Check the entered key or .env.' :
                            `TypeSafe service error (${upstream.status}). Wait, then retry.`;
                        return json(res, 502, { error });
                    }
                    const result = parseAnswer(await upstream.json());
                    json(res, 200, { ...result, request, latencyMs: Date.now() - started });
                } catch {
                    json(res, 502, { error: controller.signal.aborted ? 'Jev request timed out or was cancelled. Retry.' :
                        'Jev could not return a valid decision. Retry.' });
                } finally {
                    clearTimeout(timeout);
                    res.off('close', cancel);
                    busy = false;
                }
                return;
            }
            if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
            const pathname = decodeURIComponent(url.pathname);
            const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
            const extensions = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav' };
            const ext = path.extname(relative);
            if ((relative !== 'index.html' && !relative.startsWith('data/')) || !extensions[ext] ||
                relative.split(/[\\/]/).some(part => part.startsWith('.')) || relative.includes('\\')) {
                return json(res, 404, { error: 'Not found.' });
            }
            const content = await readFile(path.join(__dirname, relative));
            res.writeHead(200, { 'Content-Type': extensions[ext], 'X-Content-Type-Options': 'nosniff' });
            res.end(req.method === 'HEAD' ? undefined : content);
        } catch (error) {
            json(res, error.code === 'ENOENT' ? 404 : 400, { error: 'Request could not be served.' });
        }
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    createServer().listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Flappy Jev: http://localhost:${port}`));
}
module.exports = { createServer, validateState, parseAnswer };
