#!/usr/bin/env node
/*
 * Offline calibration for the Jev pilot, v2 contract.
 *
 *   node harness/calibrate.js [--repeat=N] [--dry-run] [--lead=F]
 *
 * Sends 24 hand-written scenes through the real translator and the real question
 * and checks that Jev's FLAP / WAIT matches what the criteria say. Exit 0 when at
 * least 22 of 24 pass, 1 when Jev disagrees, 2 when the harness cannot run.
 */
try { require("dotenv").config(); } catch (e) { /* dotenv is optional */ }

const JevTranslator = require("../data/jev/scene-translator.js");
const JevQuestions = require("../data/jev/jev-questions.js");

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const PASS_BAR = 22;

// world: canvas 900 tall, ground at 850, bird at x 100, collision radius 15,
// one pipe with a 125 px gap. off = bird y minus gap centre (positive = lower),
// v = px per frame (negative = up), dist = pipe x1 minus the bird's front edge.
function scene(o) {
    const gapCenter = 450;
    const x1 = 115 + (o.dist == null ? 150 : o.dist);
    return {
        birdX: 100, birdY: gapCenter + o.off, birdVelocity: o.v, birdRadius: 15, groundY: 850,
        pipes: [
            { x1: x1, x2: x1 + 50, gapTop: gapCenter - 62.5, gapBottom: gapCenter + 62.5 },
            { x1: x1 + 250, x2: x1 + 300, gapTop: 300 - 62.5, gapBottom: 300 + 62.5 }
        ]
    };
}

// expectations follow the criteria literally:
// FLAP = below the gap, or lower half and not rising; WAIT = everything else
const CASES = [
    { name: "centre, level, pipe far",              expect: "WAIT", input: scene({ off: 0,   v: 0,   dist: 300 }) },
    { name: "slightly low, falling, pipe far",      expect: "FLAP", input: scene({ off: 6,   v: 3,   dist: 300 }) },
    { name: "centre, rising",                       expect: "WAIT", input: scene({ off: 0,   v: -4,  dist: 150 }) },
    { name: "lower half, falling, pipe close",      expect: "FLAP", input: scene({ off: 25,  v: 3,   dist: 60 }) },
    { name: "lower half, level",                    expect: "FLAP", input: scene({ off: 25,  v: 0.5, dist: 150 }) },
    { name: "lower half, rising",                   expect: "WAIT", input: scene({ off: 25,  v: -3,  dist: 150 }) },
    { name: "lower half, falling fast, in pipe",    expect: "FLAP", input: scene({ off: 30,  v: 6,   dist: -20 }) },
    { name: "upper half, falling",                  expect: "WAIT", input: scene({ off: -25, v: 3,   dist: 150 }) },
    { name: "upper half, falling fast, pipe close", expect: "WAIT", input: scene({ off: -20, v: 5,   dist: 40 }) },
    { name: "upper half, rising",                   expect: "WAIT", input: scene({ off: -25, v: -3,  dist: 150 }) },
    { name: "upper half, level, in pipe",           expect: "WAIT", input: scene({ off: -15, v: 0,   dist: -20 }) },
    { name: "just below the gap, falling",          expect: "FLAP", input: scene({ off: 55,  v: 3,   dist: 150 }) },
    { name: "just below the gap, rising",           expect: "FLAP", input: scene({ off: 55,  v: -3,  dist: 150 }) },
    { name: "far below the gap, falling fast",      expect: "FLAP", input: scene({ off: 200, v: 7,   dist: 200 }) },
    { name: "far below the gap, rising",            expect: "FLAP", input: scene({ off: 150, v: -5,  dist: 100 }) },
    { name: "below the gap, pipe right there",      expect: "FLAP", input: scene({ off: 70,  v: 2,   dist: 5 }) },
    { name: "just above the gap, falling",          expect: "WAIT", input: scene({ off: -55, v: 3,   dist: 150 }) },
    { name: "just above the gap, falling fast",     expect: "WAIT", input: scene({ off: -60, v: 6,   dist: 60 }) },
    { name: "far above the gap, falling fast",      expect: "WAIT", input: scene({ off: -200, v: 8,  dist: 200 }) },
    { name: "far above the gap, rising",            expect: "WAIT", input: scene({ off: -150, v: -4, dist: 100 }) },
    { name: "above the gap, pipe right there",      expect: "WAIT", input: scene({ off: -70, v: 4,   dist: 5 }) },
    { name: "near the ground, below the gap",       expect: "FLAP", input: scene({ off: 380, v: 5,   dist: 250 }) },
    { name: "lower half, just flapped, rising",     expect: "WAIT", input: scene({ off: 20,  v: -6,  dist: 80 }) },
    { name: "bottom edge of gap, level",            expect: "FLAP", input: scene({ off: 45,  v: 0,   dist: 30 }) }
];

function parseArgs(argv) {
    const opts = { repeat: 1, dryRun: false, lead: 0 };
    for (const arg of argv) {
        if (arg === "--dry-run") opts.dryRun = true;
        else if (arg.startsWith("--repeat=")) opts.repeat = Math.max(1, parseInt(arg.slice(9), 10) || 1);
        else if (arg.startsWith("--lead=")) opts.lead = parseInt(arg.slice(7), 10) || 0;
        else { console.error("unknown flag " + arg); process.exit(2); }
    }
    return opts;
}

async function ask(state, key) {
    const t0 = performance.now();
    const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ state: state, model: MODEL, questions: JevQuestions.build() })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + " " + text.slice(0, 200));
    const json = JSON.parse(text);
    return { answer: json.answers.decision, usage: json.usage || {}, ms: performance.now() - t0 };
}

async function pool(limit, tasks) {
    const results = new Array(tasks.length);
    let next = 0;
    async function worker() {
        while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    console.log("translator v" + JevTranslator.VERSION + " | question: " + Object.keys(JevQuestions.build()).join(", ") +
        " | repeat " + opts.repeat + " | lead " + opts.lead + " frames");

    const described = CASES.map(c => JevTranslator.describeScene(c.input, opts.lead, 1));

    if (opts.dryRun) {
        described.forEach((d, i) => {
            console.log("#" + (i + 1) + "  " + CASES[i].name + "  expect " + CASES[i].expect);
            console.log("    " + JSON.stringify(d.state));
        });
        return 0;
    }

    const key = process.env.TYPESAFE_API_KEY;
    if (!key) { console.error("TYPESAFE_API_KEY is not set (put it in .env)"); return 2; }

    const tasks = [];
    described.forEach((d, i) => {
        for (let r = 0; r < opts.repeat; r++) {
            tasks.push(async () => {
                try { return Object.assign({ i, ok: true }, await ask(d.state, key)); }
                catch (e) { return { i, ok: false, error: e.message }; }
            });
        }
    });
    const results = await pool(4, tasks);

    const errors = results.filter(r => !r.ok);
    if (errors.length > results.length / 2) {
        console.error("most requests failed, e.g. " + errors[0].error);
        return 2;
    }

    let passes = 0, marginSum = 0, tokIn = 0, tokOut = 0;
    const lat = [];
    const failures = [];
    console.log("\n" + pad("#", 4) + pad("case", 40) + pad("exp", 6) + pad("act", 6) + pad("p(FLAP)", 9) + pad("conf", 6) + "res");
    console.log("-".repeat(78));
    CASES.forEach((c, i) => {
        const rs = results.filter(r => r.i === i && r.ok);
        if (rs.length === 0) { console.log(pad(i + 1, 4) + pad(c.name, 40) + "no answer"); return; }
        let pFlap = 0;
        rs.forEach(r => {
            pFlap += (r.answer.probabilities && r.answer.probabilities.FLAP) || 0;
            lat.push(r.ms);
            tokIn += r.usage.input_tokens || 0;
            tokOut += r.usage.output_tokens || 0;
        });
        pFlap /= rs.length;
        const act = pFlap >= 0.5 ? "FLAP" : "WAIT";
        const pass = act === c.expect;
        const pExp = c.expect === "FLAP" ? pFlap : 1 - pFlap;
        marginSum += pExp - 0.5;
        if (pass) passes++; else failures.push({ i, c, pFlap, d: described[i], a: rs[0].answer });
        const conf = rs[0].answer.confidence != null ? rs[0].answer.confidence.toFixed(2) : "-";
        console.log(pad(i + 1, 4) + pad(c.name, 40) + pad(c.expect, 6) + pad(act, 6) + pad(pFlap.toFixed(2), 9) + pad(conf, 6) + (pass ? "PASS" : "FAIL"));
    });

    lat.sort((a, b) => a - b);
    const mean = lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length);
    const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] || 0;
    console.log("\n" + passes + "/" + CASES.length + " passed, mean margin (p(expected) - 0.5) = " + (marginSum / CASES.length).toFixed(3));
    console.log("requests " + results.length + " (" + errors.length + " errored), tokens " + tokIn + " in / " + tokOut + " out, latency mean " +
        Math.round(mean) + " ms, p95 " + Math.round(p95) + " ms");

    for (const f of failures) {
        console.log("\n--- #" + (f.i + 1) + " " + f.c.name + ": expected " + f.c.expect + ", p(FLAP) = " + f.pFlap.toFixed(2));
        console.log("state: " + JSON.stringify(f.d.state));
        console.log("answer: " + JSON.stringify(f.a));
    }
    return passes >= PASS_BAR ? 0 : 1;
}

main().then(code => process.exit(code), e => { console.error("harness crashed: " + e.stack); process.exit(2); });
