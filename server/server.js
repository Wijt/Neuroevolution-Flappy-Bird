require("dotenv").config();

const path = require("path");
const express = require("express");
const { Agent, setGlobalDispatcher } = require("undici");

// Every request to TypeSafe costs one round trip on a warm connection and three on a cold
// one (DNS + TCP + TLS, about 750 ms from here). Node drops idle sockets after 4 s, so a
// flight that starts after a pause always paid the cold price. Keep sockets around longer.
setGlobalDispatcher(new Agent({
    keepAliveTimeout: 60 * 1000,
    keepAliveMaxTimeout: 10 * 60 * 1000,
    connections: 4
}));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TYPESAFE_API_KEY;
const UPSTREAM = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 8000;
const QUESTION_TYPES = ["noul", "choice", "score"];
const LOG_EVERY = 100;

const app = express();

const counters = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0
};

// 1. Guard: never serve secrets or server-side sources, whatever the static layer thinks.
app.use(function (req, res, next) {
    const p = req.path;
    if (/(^|\/)\.env/i.test(p)) {
        res.status(404).end();
        return;
    }
    if (p === "/node_modules" || p.indexOf("/node_modules/") === 0 ||
        p === "/server" || p.indexOf("/server/") === 0 ||
        p === "/harness" || p.indexOf("/harness/") === 0) {
        res.status(404).end();
        return;
    }
    next();
});

// 2. JSON body parsing, small limit: states are tiny.
app.use(express.json({ limit: "32kb" }));

// 3. Static game files from the repository root.
app.use(express.static(path.join(__dirname, ".."), { extensions: ["html"] }));

function isPlainObject(value) {
    return typeof value === "object" && value !== null;
}

function validateQuestions(questions) {
    if (!isPlainObject(questions) || Array.isArray(questions)) {
        return { error: "bad_questions" };
    }
    const ids = Object.keys(questions);
    if (ids.length < 1 || ids.length > 8) {
        return { error: "bad_question_count" };
    }
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const q = questions[id];
        if (!isPlainObject(q) || Array.isArray(q)) {
            return { error: "bad_question", id: id };
        }
        if (QUESTION_TYPES.indexOf(q.type) === -1) {
            return { error: "bad_question", id: id };
        }
        const instructionsOk = typeof q.instructions === "string" ||
            (typeof q.instructions === "object" && q.instructions !== null);
        if (!instructionsOk) {
            return { error: "bad_question", id: id };
        }
    }
    return null;
}

app.post("/api/jev", async function (req, res) {
    if (!API_KEY) {
        res.status(500).json({ error: "server_not_configured" });
        return;
    }

    const body = isPlainObject(req.body) ? req.body : {};
    const state = body.state;
    const questions = body.questions;

    if (!isPlainObject(state)) {
        res.status(400).json({ error: "bad_state" });
        return;
    }

    const questionError = validateQuestions(questions);
    if (questionError) {
        res.status(400).json(questionError);
        return;
    }

    // Forward only what we control: the client can never choose the model.
    const payload = { state: state, model: MODEL, questions: questions };

    const controller = new AbortController();
    const timer = setTimeout(function () {
        controller.abort();
    }, TIMEOUT_MS);
    const startedAt = Date.now();

    try {
        const upstream = await fetch(UPSTREAM, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + API_KEY
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!upstream.ok) {
            let bodyText = "";
            try {
                bodyText = await upstream.text();
            } catch (readError) {
                bodyText = "<unreadable>";
            }
            console.warn("[jev] upstream", upstream.status, bodyText.slice(0, 200));
            res.status(upstream.status).json({ error: "upstream_error", status: upstream.status });
            return;
        }

        const data = await upstream.json();
        const latencyMs = Date.now() - startedAt;

        counters.requests += 1;
        counters.latencyMs += latencyMs;
        if (data && data.usage) {
            counters.inputTokens += data.usage.input_tokens || 0;
            counters.outputTokens += data.usage.output_tokens || 0;
        }
        if (counters.requests % LOG_EVERY === 0) {
            const avg = Math.round(counters.latencyMs / counters.requests);
            console.log("[jev] " + counters.requests + " requests, " +
                counters.inputTokens + " input tokens, avg " + avg + " ms");
        }

        res.json(data);
    } catch (error) {
        if (error && error.name === "AbortError") {
            res.status(504).json({ error: "upstream_timeout" });
            return;
        }
        console.warn("[jev] upstream unreachable", error && error.message);
        res.status(502).json({ error: "upstream_unreachable" });
    } finally {
        clearTimeout(timer);
    }
});

app.listen(PORT, function () {
    console.log("Flappy Jev running at http://localhost:" + PORT);
});
