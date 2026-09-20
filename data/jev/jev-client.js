// Fetch pump for the Jev pilot.
// Fire and forget: send() never blocks the game loop and never throws.
// Answers land in an inbox that the scene drains once per frame.
class JevClient {
    constructor(opts) {
        opts = opts || {};

        this.endpoint = opts.endpoint || "/api/jev";
        this.maxInFlight = opts.maxInFlight || 2;
        this.timeoutMs = opts.timeoutMs || 4000;

        this.inFlight = 0;
        this.backoffUntilMs = 0;
        this.backoffStepMs = 0;

        //every request gets a number so the trace can pair a send with its answer
        this.nextReqId = 0;

        this.inbox = [];
        this.controllers = [];

        // requests/answers/tokens are the client's own; the scene keeps the four
        // timing counters here too so there is one place to read the loop off
        this.stats = {
            requests: 0,
            answers: 0,
            errors: 0,
            discarded: 0,
            superseded: 0,
            stale: 0,
            applied: 0,
            held: 0,
            inputTokens: 0,
            outputTokens: 0,
            lastLatencyMs: 0,
            lastUpstreamMs: null,
            lastError: null
        };
    }

    canSend() {
        if (this.inFlight >= this.maxInFlight) return false;
        if (Date.now() < this.backoffUntilMs) return false;
        return true;
    }

    // Returns the request id when a request actually went out, 0 otherwise.
    send(state, questions, tag) {
        if (!this.canSend()) return 0;

        let controller = new AbortController();
        controller.deliberateAbort = false;

        let reqId = ++this.nextReqId;
        if (tag != null) tag.reqId = reqId;

        let startedAt = Date.now();
        //the gateway's own time, when it is exposed at all
        let upstreamMs = null;
        let timer = setTimeout(() => {
            controller.abort();
        }, this.timeoutMs);

        this.controllers.push(controller);
        this.inFlight++;
        this.stats.requests++;

        let done = () => {
            if (timer != null) {
                clearTimeout(timer);
                timer = null;
            }
            this.inFlight--;
            let i = this.controllers.indexOf(controller);
            if (i !== -1) this.controllers.splice(i, 1);
        };

        fetch(this.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state: state, questions: questions }),
            signal: controller.signal
        }).then(response => {
            if (!response.ok) throw new Error("http " + response.status);

            // Envoy puts the upstream's service time here. Our proxy is same origin,
            // so a header is only readable when the proxy forwards it; usually it does
            // not and the panel shows "-".
            let served = response.headers.get("x-envoy-upstream-service-time");
            if (served != null && served !== "") upstreamMs = Number(served);

            return response.json(); // a broken body rejects here, the catch below takes it
        }).then(body => {
            if (body == null || body.answers == null) throw new Error("no answers in the response");

            let usage = body.usage || {};
            let latencyMs = Date.now() - startedAt;

            this.inbox.push({
                reqId: reqId,
                tag: tag,
                answers: body.answers,
                usage: usage,
                latencyMs: latencyMs
            });

            this.stats.answers++;
            this.stats.inputTokens += usage.input_tokens || 0;
            this.stats.outputTokens += usage.output_tokens || 0;
            this.stats.lastLatencyMs = latencyMs;
            this.stats.lastUpstreamMs = (upstreamMs != null && isFinite(upstreamMs)) ? upstreamMs : null;

            // a good answer clears the backoff
            this.backoffStepMs = 0;
            this.backoffUntilMs = 0;
        }).catch(error => {
            // abortAll() is us pulling the plug on purpose, that is not an error
            if (controller.deliberateAbort) return;
            this.noteError(error);
        }).then(done, done);

        return reqId;
    }

    noteError(error) {
        let message = (error && error.message) ? error.message : String(error);

        this.stats.errors++;
        this.stats.lastError = message;

        console.warn("jev request failed: " + message);

        if (this.backoffStepMs === 0) this.backoffStepMs = 1000;
        else this.backoffStepMs = Math.min(this.backoffStepMs * 2, 8000);

        this.backoffUntilMs = Date.now() + this.backoffStepMs;
    }

    takeAnswer() {
        if (this.inbox.length === 0) return null;
        return this.inbox.shift();
    }

    abortAll() {
        this.controllers.slice().forEach(controller => {
            controller.deliberateAbort = true;
            try {
                controller.abort();
            } catch (error) {
                // nothing sensible to do, the request is going away either way
            }
        });
        this.inbox = [];
    }
}
