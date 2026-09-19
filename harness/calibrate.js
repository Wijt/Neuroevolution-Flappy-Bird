"use strict";

/*
 * Offline calibration harness for the Jev pilot.
 *
 * Sends 25 hand-built scenes to TypeSafe's System One endpoint in two state
 * formats and reports which format decides the scenes the way a human would.
 *
 *   node harness/calibrate.js [--repeat=N] [--format=json|prose|both] [--dry-run]
 *
 * The game acts on the `maneuver` choice, so this harness scores that choice.
 * Each case lists the maneuvers a human pilot would accept; the case passes
 * when the chosen maneuver is one of them.
 *
 * Exit codes: 0 pass, 1 calibration below the bar, 2 config/transport failure.
 */

try {
    require("dotenv").config();
} catch (err) {
    // dotenv is optional here; the key may come from the real environment.
}

const JevTranslator = require("../data/jev/scene-translator.js");
const JevQuestions = require("../data/jev/jev-questions.js");

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 20000;
const PASS_BAR = 22;
const CRITICAL_CASES = [6, 7, 24, 25];

const MANEUVERS = ["let_it_fall", "one_hop", "two_hops", "climb_hard"];
const SHORT = {
    let_it_fall: "fall",
    one_hop: "1hop",
    two_hops: "2hop",
    climb_hard: "climb"
};

const CANVAS_HEIGHT = 800;
const GROUND_Y = 750;
const BIRD_X = 100;
const BIRD_R = 15;
const DEFAULT_FRAMES_SINCE_FLAP = 30;
const DEFAULT_GAP_CENTER = 400;

const PIPE_FAR = { x1: 400, x2: 450 };
const PIPE_SOME_DISTANCE = { x1: 260, x2: 310 };
const PIPE_CLOSE = { x1: 160, x2: 210 };
const PIPE_IN_FRONT = { x1: 130, x2: 180 };
const PIPE_BETWEEN = { x1: 90, x2: 140 };
const PIPE_VERY_FAR = { x1: 600, x2: 650 };

/* ------------------------------------------------------------------ cases */

function scene(opts) {
    const gapCenter = opts.gapCenter === undefined ? DEFAULT_GAP_CENTER : opts.gapCenter;
    const pipe = opts.pipe || PIPE_FAR;
    const birdY = opts.birdY !== undefined ? opts.birdY : gapCenter + (opts.offset || 0);

    return {
        birdX: BIRD_X,
        birdY: birdY,
        birdVelocity: opts.v === undefined ? 0 : opts.v,
        birdRadius: BIRD_R,
        framesSinceFlap: opts.framesSinceFlap === undefined
            ? DEFAULT_FRAMES_SINCE_FLAP
            : opts.framesSinceFlap,
        nextPipe: { x1: pipe.x1, x2: pipe.x2, gapCenter: gapCenter },
        followingPipe: opts.followingGapCenter === undefined
            ? null
            : { gapCenter: opts.followingGapCenter },
        groundY: GROUND_Y,
        canvasHeight: CANVAS_HEIGHT
    };
}

// `expect` is the set of maneuvers a human pilot would accept for the case.
const CASES = [
    { name: "centre, barely drifting, pipe far", expect: ["let_it_fall", "one_hop"], input: scene({ offset: 0, v: 0.2, pipe: PIPE_FAR }) },
    // #2 is debatable: the bird is falling but the pipe is far away, so both
    // catching it now and letting it drop a while longer are defensible.
    { name: "centre, falling fast, pipe far", expect: ["one_hop", "let_it_fall"], input: scene({ offset: 0, v: 5, pipe: PIPE_FAR }) },
    { name: "centre, rising fast, pipe far", expect: ["let_it_fall"], input: scene({ offset: 0, v: -5, pipe: PIPE_FAR }) },
    { name: "ground close, falling", expect: ["climb_hard", "two_hops"], input: scene({ birdY: 740, v: 4, pipe: PIPE_FAR }) },
    { name: "ground close, dropping fast", expect: ["climb_hard", "two_hops"], input: scene({ birdY: 730, v: 6, pipe: PIPE_FAR }) },
    { name: "ceiling close, still rising", expect: ["let_it_fall"], input: scene({ birdY: 20, v: -5, pipe: PIPE_FAR }) },
    { name: "ceiling close, dropping fast", expect: ["let_it_fall"], input: scene({ birdY: 20, v: 6, pipe: PIPE_FAR }) },
    { name: "60 below gap, pipe close ahead", expect: ["one_hop", "two_hops"], input: scene({ offset: 60, pipe: PIPE_CLOSE }) },
    { name: "60 above gap, pipe close ahead", expect: ["let_it_fall"], input: scene({ offset: -60, pipe: PIPE_CLOSE }) },
    { name: "45 below gap, pipe in front", expect: ["one_hop", "two_hops"], input: scene({ offset: 45, pipe: PIPE_IN_FRONT }) },
    { name: "45 above gap, pipe in front", expect: ["let_it_fall"], input: scene({ offset: -45, pipe: PIPE_IN_FRONT }) },
    { name: "between pipes, centred, still", expect: ["one_hop", "let_it_fall"], input: scene({ offset: 0, v: 0, pipe: PIPE_BETWEEN }) },
    { name: "between pipes, 40 below, falling", expect: ["one_hop", "two_hops"], input: scene({ offset: 40, v: 5, pipe: PIPE_BETWEEN }) },
    { name: "between pipes, 40 above, rising", expect: ["let_it_fall"], input: scene({ offset: -40, v: -3, pipe: PIPE_BETWEEN }) },
    { name: "25 below gap, dropping fast", expect: ["two_hops", "one_hop"], input: scene({ offset: 25, v: 7, pipe: PIPE_SOME_DISTANCE }) },
    { name: "25 above gap, shooting up", expect: ["let_it_fall"], input: scene({ offset: -25, v: -6, pipe: PIPE_SOME_DISTANCE }) },
    { name: "centred, falling, pipe close ahead", expect: ["let_it_fall", "one_hop"], input: scene({ offset: 0, v: 3.5, pipe: PIPE_CLOSE }) },
    { name: "centred, hanging, just flapped", expect: ["let_it_fall", "one_hop"], input: scene({ offset: 0, v: -0.5, framesSinceFlap: 3, pipe: PIPE_FAR }) },
    { name: "gap high above the bird", expect: ["climb_hard", "two_hops"], input: scene({ gapCenter: 200, birdY: 400, pipe: PIPE_SOME_DISTANCE }) },
    { name: "gap well below the bird", expect: ["let_it_fall"], input: scene({ gapCenter: 600, birdY: 400, pipe: PIPE_SOME_DISTANCE }) },
    { name: "low over the ground, falling", expect: ["two_hops", "climb_hard"], input: scene({ birdY: 700, v: 3, pipe: PIPE_VERY_FAR }) },
    { name: "high near the ceiling, falling", expect: ["let_it_fall"], input: scene({ birdY: 40, v: 3, pipe: PIPE_FAR }) },
    { name: "slightly low, falling, pipe in front", expect: ["let_it_fall", "one_hop"], input: scene({ offset: 10, v: 5.5, pipe: PIPE_IN_FRONT }) },
    { name: "between pipes, a little low, next opening well above", expect: ["one_hop", "two_hops", "climb_hard"], input: scene({ offset: 25, v: 3, pipe: PIPE_BETWEEN, followingGapCenter: 280 }) },
    { name: "between pipes, next opening well below", expect: ["let_it_fall"], input: scene({ offset: 0, v: 0, pipe: PIPE_BETWEEN, followingGapCenter: 520 }) }
];

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
    const opts = { repeat: 1, dryRun: false, formats: ["json", "prose"] };

    for (const arg of argv) {
        if (arg === "--dry-run") {
            opts.dryRun = true;
        } else if (arg.startsWith("--repeat=")) {
            const n = Number.parseInt(arg.slice("--repeat=".length), 10);
            if (!Number.isFinite(n) || n < 1) {
                console.error("--repeat must be a positive integer");
                process.exit(2);
            }
            opts.repeat = n;
        } else if (arg.startsWith("--format=")) {
            const value = arg.slice("--format=".length);
            if (value === "both") {
                opts.formats = ["json", "prose"];
            } else if (value === "json" || value === "prose") {
                opts.formats = [value];
            } else {
                console.error("--format must be json, prose or both");
                process.exit(2);
            }
        } else {
            console.error("unknown flag: " + arg);
            process.exit(2);
        }
    }

    return opts;
}

/* -------------------------------------------------------------- utilities */

function buildBody(format, described) {
    if (format === "json") return described.state;
    // The prose already starts with RULES_TEXT, so the rules must not be
    // repeated in a second field.
    return { situation: described.prose };
}

function pad(text, width) {
    const s = String(text);
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(text, width) {
    const s = String(text);
    return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function mean(values) {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function percentile(sorted, q) {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index];
}

function shortName(maneuver) {
    return SHORT[maneuver] || maneuver;
}

function shortList(maneuvers) {
    return maneuvers.map(shortName).join(",");
}

function formatDistribution(probabilities) {
    return MANEUVERS
        .map(function (m) {
            const p = Number(probabilities && probabilities[m]);
            return shortName(m) + "=" + (Number.isFinite(p) ? p.toFixed(2) : "n/a");
        })
        .join("  ");
}

async function runPool(tasks, limit, worker) {
    let next = 0;
    const runners = [];
    const size = Math.min(limit, tasks.length);

    for (let i = 0; i < size; i++) {
        runners.push((async function () {
            for (;;) {
                const index = next++;
                if (index >= tasks.length) return;
                await worker(tasks[index]);
            }
        })());
    }

    await Promise.all(runners);
}

async function callApi(body, apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    const started = Date.now();

    try {
        const response = await fetch(ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + apiKey
            },
            body: JSON.stringify({
                state: body,
                model: MODEL,
                questions: JevQuestions.build()
            }),
            signal: controller.signal
        });

        const latencyMs = Date.now() - started;

        if (!response.ok) {
            let detail = "";
            try {
                detail = (await response.text()).slice(0, 200);
            } catch (err) {
                detail = "";
            }
            return { ok: false, latencyMs: latencyMs, error: "HTTP " + response.status + " " + detail };
        }

        const json = await response.json();
        const answers = json && json.answers;
        const maneuver = answers && answers.maneuver;
        const choice = maneuver && maneuver.choice;
        const probabilities = maneuver && maneuver.probabilities;

        if (!choice || !probabilities) {
            return { ok: false, latencyMs: latencyMs, error: "missing answers.maneuver.choice / probabilities" };
        }

        return {
            ok: true,
            latencyMs: latencyMs,
            choice: choice,
            probabilities: probabilities,
            answers: answers,
            usage: json.usage || {}
        };
    } catch (err) {
        const latencyMs = Date.now() - started;
        const message = err && err.name === "AbortError"
            ? "timeout after " + REQUEST_TIMEOUT_MS + " ms"
            : String((err && err.message) || err);
        return { ok: false, latencyMs: latencyMs, error: message };
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------------------------------------------------------- dry run */

function dryRun(described) {
    console.log("dry run - no network. translator v" + JevTranslator.VERSION +
        ", hops " + JSON.stringify(JevQuestions.HOPS) +
        ", spacing " + JevQuestions.HOP_SPACING_FRAMES + " frames\n");

    CASES.forEach(function (c, i) {
        const d = described[i];
        console.log("#" + (i + 1) + "  " + c.name);
        console.log("    expect: " + c.expect.join(" | "));
        console.log("    state : " + JSON.stringify(d.state, null, 4).split("\n").join("\n    "));
        console.log("    prose : " + d.prose);
        console.log("");
    });

    console.log(CASES.length + " cases described. No requests sent.");
}

/* ------------------------------------------------------------------- main */

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const described = CASES.map(function (c) { return JevTranslator.describeScene(c.input); });

    if (opts.dryRun) {
        dryRun(described);
        process.exit(0);
    }

    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) {
        console.error("TYPESAFE_API_KEY is not set (put it in .env or the environment).");
        console.error("Run with --dry-run to inspect the scenes without calling the API.");
        process.exit(2);
    }

    const results = {};
    for (const format of opts.formats) {
        results[format] = CASES.map(function () {
            return { dists: [], answers: null, errors: [] };
        });
    }

    const tasks = [];
    for (const format of opts.formats) {
        for (let i = 0; i < CASES.length; i++) {
            for (let r = 0; r < opts.repeat; r++) {
                tasks.push({ format: format, index: i });
            }
        }
    }

    const latencies = [];
    const totals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };

    await runPool(tasks, CONCURRENCY, async function (task) {
        const body = buildBody(task.format, described[task.index]);
        const out = await callApi(body, apiKey);
        const slot = results[task.format][task.index];

        totals.requests++;
        latencies.push(out.latencyMs);

        if (!out.ok) {
            totals.errors++;
            slot.errors.push(out.error);
            return;
        }

        slot.dists.push(out.probabilities);
        if (!slot.answers) slot.answers = out.answers;
        totals.inputTokens += Number(out.usage.input_tokens) || 0;
        totals.outputTokens += Number(out.usage.output_tokens) || 0;
    });

    if (totals.requests === 0 || totals.errors === totals.requests) {
        console.error("every request failed - check the key, the network and the endpoint.");
        const firstFormat = opts.formats[0];
        const firstError = results[firstFormat]
            .map(function (s) { return s.errors[0]; })
            .find(function (e) { return e; });
        if (firstError) console.error("first error: " + firstError);
        process.exit(2);
    }

    const report = buildReport(opts, results);
    printReport(report, opts, described, totals, latencies);

    if (totals.errors > totals.requests / 2) {
        console.error("\nmore than half of the requests failed - treating this as a transport failure.");
        process.exit(2);
    }

    const summary = report.summaries[report.recommended];
    const criticalOk = CRITICAL_CASES.every(function (n) { return summary.cases[n - 1].pass; });

    if (summary.passes >= PASS_BAR && criticalOk) {
        process.exit(0);
    }
    process.exit(1);
}

// Average the per-maneuver probabilities over the repeats of one case.
function averageDistribution(dists) {
    const avg = {};
    for (const m of MANEUVERS) {
        const values = dists
            .map(function (d) { return Number(d && d[m]); })
            .filter(function (v) { return Number.isFinite(v); });
        avg[m] = values.length > 0 ? mean(values) : 0;
    }
    return avg;
}

function argMax(distribution) {
    let best = null;
    for (const m of MANEUVERS) {
        if (best === null || distribution[m] > distribution[best]) best = m;
    }
    return best;
}

// Margin: probability of the chosen maneuver minus the best probability among
// the maneuvers that are NOT acceptable for the case. Positive is good.
function marginFor(distribution, chosen, expect) {
    const rivals = MANEUVERS.filter(function (m) { return expect.indexOf(m) === -1; });
    if (rivals.length === 0) return distribution[chosen];
    let bestRival = 0;
    for (const m of rivals) {
        if (distribution[m] > bestRival) bestRival = distribution[m];
    }
    return distribution[chosen] - bestRival;
}

function buildReport(opts, results) {
    const summaries = {};

    for (const format of opts.formats) {
        const cases = results[format].map(function (slot, i) {
            const hasData = slot.dists.length > 0;
            const expect = CASES[i].expect;
            const distribution = hasData ? averageDistribution(slot.dists) : null;
            const act = distribution ? argMax(distribution) : null;
            const p = distribution ? distribution[act] : NaN;
            const margin = distribution ? marginFor(distribution, act, expect) : NaN;
            return {
                index: i,
                name: CASES[i].name,
                expect: expect,
                distribution: distribution,
                p: p,
                margin: margin,
                act: act,
                pass: act !== null && expect.indexOf(act) !== -1,
                errors: slot.errors,
                answers: slot.answers
            };
        });

        const passes = cases.filter(function (c) { return c.pass; }).length;
        const margins = cases
            .filter(function (c) { return Number.isFinite(c.margin); })
            .map(function (c) { return c.margin; });

        summaries[format] = { cases: cases, passes: passes, meanMargin: mean(margins) };
    }

    let recommended = opts.formats[0];
    for (const format of opts.formats) {
        const a = summaries[format];
        const b = summaries[recommended];
        if (a.passes > b.passes || (a.passes === b.passes && a.meanMargin > b.meanMargin)) {
            recommended = format;
        }
    }

    return { summaries: summaries, recommended: recommended };
}

function printReport(report, opts, described, totals, latencies) {
    const formats = opts.formats;
    const nameWidth = Math.max.apply(null, CASES.map(function (c) { return c.name.length; }).concat([4]));
    const expWidth = Math.max.apply(null, CASES.map(function (c) { return shortList(c.expect).length; }).concat([3])) + 2;
    const cellWidth = 22;

    let header = pad("#", 4) + pad("case", nameWidth + 2) + pad("expect", expWidth);
    for (const format of formats) {
        header += pad(pad("act", 7) + padLeft("p", 5) + "  res", cellWidth);
    }
    console.log("\ntranslator v" + JevTranslator.VERSION + " | maneuver hops " +
        JSON.stringify(JevQuestions.HOPS) + " | repeat " + opts.repeat +
        " | formats: " + formats.join(", "));
    console.log(header);
    console.log("-".repeat(header.length));

    for (let i = 0; i < CASES.length; i++) {
        let line = pad(i + 1, 4) + pad(CASES[i].name, nameWidth + 2) + pad(shortList(CASES[i].expect), expWidth);
        for (const format of formats) {
            const c = report.summaries[format].cases[i];
            const act = c.act === null ? "?" : shortName(c.act);
            const pText = Number.isFinite(c.p) ? padLeft(c.p.toFixed(2), 5) : padLeft("ERR", 5);
            line += pad(pad(act, 7) + pText + "  " + pad(c.pass ? "PASS" : "FAIL", 5), cellWidth);
        }
        console.log(line);
    }

    for (const format of formats) {
        const s = report.summaries[format];
        const pct = ((s.passes / CASES.length) * 100).toFixed(0);
        console.log("\n[" + format + "] " + s.passes + "/" + CASES.length + " passed (" + pct + "%)" +
            ", mean margin (chosen minus best unacceptable) = " + s.meanMargin.toFixed(3));
        const failures = s.cases.filter(function (c) { return !c.pass; });
        if (failures.length === 0) {
            console.log("  failures: none");
        } else {
            console.log("  failures: " + failures.map(function (c) {
                return "#" + (c.index + 1) + " " + c.name;
            }).join("; "));
        }
    }

    const sortedLatencies = latencies.slice().sort(function (a, b) { return a - b; });
    console.log("\nrequests: " + totals.requests + " (" + totals.errors + " errored)");
    console.log("tokens: " + totals.inputTokens + " in / " + totals.outputTokens + " out");
    console.log("latency: mean " + Math.round(mean(latencies)) + " ms, p95 " +
        Math.round(percentile(sortedLatencies, 0.95)) + " ms");
    console.log("recommended format: " + report.recommended);

    for (const format of formats) {
        const failures = report.summaries[format].cases.filter(function (c) { return !c.pass; });
        if (failures.length === 0) continue;
        console.log("\n--- failing cases, format " + format + " ---");
        for (const c of failures) {
            console.log("\n#" + (c.index + 1) + " " + c.name + " - expected one of " +
                c.expect.join(", ") + ", got " + (c.act || "no answer"));
            if (c.distribution) {
                console.log("maneuver: " + formatDistribution(c.distribution));
            }
            console.log("state sent: " + JSON.stringify(buildBody(format, described[c.index]), null, 4));
            if (c.errors.length > 0) {
                console.log("errors: " + c.errors.join(" | "));
            }
            if (c.answers) {
                if (c.answers.read) {
                    console.log("read: choice=" + c.answers.read.choice +
                        " probabilities=" + JSON.stringify(c.answers.read.probabilities));
                }
                if (c.answers.danger) {
                    console.log("danger: score=" + c.answers.danger.score +
                        " legend=" + JSON.stringify(c.answers.danger.legend));
                }
            }
        }
    }
}

main().catch(function (err) {
    console.error("calibration crashed: " + ((err && err.stack) || err));
    process.exit(2);
});
