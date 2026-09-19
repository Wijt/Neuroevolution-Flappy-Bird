const http = require('node:http');
const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const JevContract = require('./data/jev-contract');

let keepAliveDispatcher = null;
try {
    const undici = require('undici');
    keepAliveDispatcher = new undici.Agent({ keepAliveTimeout: 30_000, connections: 8 });
} catch {
    keepAliveDispatcher = null;
}

const GAME_CONSTANTS = { gravity: 0.4, jumpPower: 6, pipeSpeed: 2 };
const MINUTE_MS = 60_000;

function isFiniteInRange(v, min, max) {
    return Number.isFinite(v) && v >= min && v <= max;
}

function validateGameState(state) {
    if (!state || typeof state !== 'object') return false;
    const bird = state.bird;
    const world = state.world;
    const physics = state.physics;
    const pipes = state.pipes;
    if (!bird || !isFiniteInRange(bird.x, -1000, 20000) || !isFiniteInRange(bird.y, -10000, 20000) ||
        !isFiniteInRange(bird.velocity, -1000, 1000) || !isFiniteInRange(bird.radius, 1, 200)) {
        return false;
    }
    if (!world || !isFiniteInRange(world.width, 1, 20000) || !isFiniteInRange(world.groundY, 1, 20000)) {
        return false;
    }
    if (!physics || physics.gravity !== GAME_CONSTANTS.gravity || physics.jumpPower !== GAME_CONSTANTS.jumpPower ||
        physics.pipeSpeed !== GAME_CONSTANTS.pipeSpeed) {
        return false;
    }
    if (!Array.isArray(pipes) || pipes.length < 1 || pipes.length > 4) return false;
    for (const pipe of pipes) {
        if (!pipe || !isFiniteInRange(pipe.left, -20000, 20000) || !isFiniteInRange(pipe.right, pipe.left + 1, 20000) ||
            !isFiniteInRange(pipe.gapTop, 0, world.groundY) || !isFiniteInRange(pipe.gapBottom, pipe.gapTop + 1, world.groundY)) {
            return false;
        }
    }
    return true;
}

function createServer({
    apiKey = process.env.TYPESAFE_API_KEY,
    model = process.env.TYPESAFE_MODEL || 'jev-latest',
    fetchImpl = fetch,
    timeoutMs = 5000,
    maxInFlightPerKey = 3,
    maxRequestsPerMinutePerKey = 600,
    upstreamUrl = 'https://api.typesafe.ai/v1/systemone'
} = {}) {
    // keyId -> { inFlight: number, timestamps: number[] }
    const accounts = new Map();

    const json = (res, status, body) => {
        if (res.writableEnded) return;
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };

    function accountFor(keyId) {
        let account = accounts.get(keyId);
        if (!account) {
            account = { inFlight: 0, timestamps: [] };
            accounts.set(keyId, account);
        }
        return account;
    }

    function pruneWindow(account, now) {
        while (account.timestamps.length && now - account.timestamps[0] > MINUTE_MS) account.timestamps.shift();
    }

    return http.createServer(async (req, res) => {
        try {
            const host = req.headers.host || '';
            if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ||
                (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== `https://${host}`)) {
                return json(res, 403, { error: 'Only same-origin local requests are allowed.' });
            }
            const url = new URL(req.url, `http://${host}`);

            if (url.pathname === '/api/jev/decide' && req.method === 'POST') {
                if (!(req.headers['content-type'] || '').startsWith('application/json')) {
                    return json(res, 415, { error: 'Expected JSON.' });
                }
                let body = '';
                for await (const chunk of req) {
                    body += chunk;
                    if (Buffer.byteLength(body) > 65536) return json(res, 413, { error: 'Request too large.' });
                }
                let payload;
                try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }

                const id = payload?.id;
                if (typeof id !== 'string' && typeof id !== 'number') return json(res, 400, { error: 'Missing request id.' });

                if (payload?.apiKey != null && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 1024 || /[\r\n]/.test(payload.apiKey))) {
                    return json(res, 400, { error: 'Invalid API key.' });
                }
                const requestKey = payload?.apiKey?.trim() || apiKey;
                if (!requestKey) return json(res, 503, { error: 'No API key. Enter one in the page or set TYPESAFE_API_KEY.' });

                const state = payload?.state;
                // Console-edited prompt texts; unknown keys and bad values fall back to defaults.
                const prompts = payload?.prompts && typeof payload.prompts === 'object' ? payload.prompts : null;
                if (!validateGameState(state)) return json(res, 400, { error: 'Invalid game state.' });

                const keyId = createHash('sha256').update(requestKey).digest('hex');
                const account = accountFor(keyId);
                const now = Date.now();
                pruneWindow(account, now);
                if (account.inFlight >= maxInFlightPerKey) {
                    return json(res, 429, { error: 'Too many in-flight requests for this key.', retryAfterMs: 200 });
                }
                if (account.timestamps.length >= maxRequestsPerMinutePerKey) {
                    return json(res, 429, { error: 'Per-minute request limit reached for this key.', retryAfterMs: 1000 });
                }

                account.inFlight++;
                account.timestamps.push(now);

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                const cancelOnDisconnect = () => controller.abort();
                res.on('close', cancelOnDisconnect);
                const started = Date.now();
                try {
                    const request = JevContract.buildRequest(state, model, prompts);
                    const fetchOptions = {
                        method: 'POST',
                        signal: controller.signal,
                        headers: { Authorization: `Bearer ${requestKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(request)
                    };
                    if (keepAliveDispatcher) fetchOptions.dispatcher = keepAliveDispatcher;
                    const upstream = await fetchImpl(upstreamUrl, fetchOptions);

                    if (!upstream.ok) {
                        if (upstream.status === 401) {
                            return json(res, 401, { error: 'TypeSafe rejected the API key.' });
                        }
                        if (upstream.status === 429 || upstream.status === 529) {
                            const retryAfterHeader = Number(upstream.headers.get('retry-after'));
                            const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
                                ? retryAfterHeader * 1000 : 2000;
                            return json(res, 429, { error: 'TypeSafe rate limit reached.', retryAfterMs });
                        }
                        return json(res, 502, { error: `TypeSafe service error (${upstream.status}).` });
                    }

                    let upstreamBody;
                    try { upstreamBody = await upstream.json(); } catch { return json(res, 502, { error: 'TypeSafe returned an invalid response.' }); }
                    let result;
                    try { result = JevContract.parseResponse(upstreamBody); }
                    catch { return json(res, 502, { error: 'TypeSafe returned an invalid decision.' }); }

                    return json(res, 200, {
                        id, plan: result.plan, answers: result.answers,
                        model: result.model, usage: result.usage, latencyMs: Date.now() - started
                    });
                } catch {
                    return json(res, 502, {
                        error: controller.signal.aborted ? 'Jev request timed out or was cancelled.' : 'Jev could not return a valid decision.'
                    });
                } finally {
                    clearTimeout(timeout);
                    res.off('close', cancelOnDisconnect);
                    account.inFlight = Math.max(0, account.inFlight - 1);
                }
            }

            if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
            const pathname = decodeURIComponent(url.pathname);
            const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
            const extensions = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav'
            };
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

module.exports = { createServer };
