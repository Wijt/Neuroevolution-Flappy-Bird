# Flappy Bird with Jev

Watch mode asks TypeSafe's Jev model to choose `flap` or `coast` from the current game state. Play and neuroevolution training remain available.

## Run locally

Requires Node.js 22.9+ (Node 24 recommended). No npm dependencies are needed.

```powershell
npm start
```

Open http://localhost:3000, choose **watch Jev**, enter your TypeSafe API key, and press **Start**. Obtain a key from https://console.typesafe.ai.

The password field is kept only for the current watch session; it is cleared when you return to the menu. The app does not write it to localStorage, cookies, files, or logs. It sends the key to the local server, which authenticates HTTPS requests to TypeSafe. Do not expose this local development server publicly.

Alternatively, copy `.env.example` to `.env`, set `TYPESAFE_API_KEY`, and restart the server. Leave the browser field empty to use that key. A browser-supplied key takes precedence. `.env` is ignored by Git. `TYPESAFE_MODEL` defaults to `jev-latest`; set a supported version ID to pin it. `PORT` defaults to 3000.

## Watch behavior

- Jev receives exact short-term forecasts for both actions, rising/falling direction and position relative to the next gap. Coordinates and impulse behavior are explicit in the prompt (see `server.js`).
- One Choice question selects `flap` (one jump) or `coast` (no jump) for six physics ticks, about 100 ms of simulated time.
- State includes bird position/velocity, collision radius, the next three pipe gaps, ground position, gravity, pipe speed and jump strength. Physics and collisions remain in JavaScript.
- Simulation freezes while awaiting Jev. Network latency therefore slows wall-clock play rather than applying decisions to an outdated position. This is a decision-paced demo, not a real-time latency benchmark.
- The status shows the selected action, confidence, API latency and decision count. Confidence is model-reported, not a guarantee of successful play.
- While rising, safe coast steps run locally without API calls. A safety check replaces an action predicted to collide within six ticks only when the other action is safe; the UI labels this override. This is Jev with a physics safety layer, not a pure model benchmark.
- Requests are spaced at least 1.2 seconds apart in the browser (1 second on the server). The scene allows 60 attempted calls per page session, including failures, and Restart/Menu do not reset this budget. The server also caps attempts at 120 per API key per server process; deliberately restarting the server renews that cap. These are request caps, not currency limits.
- Pause/Resume, Retry, Restart and Menu control the session. Hiding the tab pauses and cancels pending work. Errors stop simulation without a pretrained-model fallback. Rate limits impose a cooldown; retry manually after waiting. Death stops requests. **Play again** starts a new round in one click. Optional **Auto restart after death** waits two seconds, makes no requests during the death screen, and continues only within the remaining budget. It is off by default.
- Requests use the paid TypeSafe API. Pause or leave watch mode to stop new calls. A request already sent may still be billed.

The pretrained brain is no longer loaded during startup or used in watch mode. Training still uses the repository's existing neural network implementation.

## Verify

```powershell
npm test
```

Tests use mocked TypeSafe responses and cover the request contract, browser/server credentials, validation, private-file protection, service failures, timeouts, rate limits, simulation pausing, stale responses, pipe recycling and death handling. They also verify request budgets, call spacing, death idle behavior, opt-in automatic restart, rising coasting and unsafe flap suppression. They do not measure Jev's playing skill. Live performance requires an API key and empirical runs.

## Docker

```sh
docker build -t flappy-jev .
docker run --rm -p 127.0.0.1:3000:3000 flappy-jev
```

Then enter a key in the browser, or pass `--env-file .env` to `docker run`. The image explicitly copies only application assets; local secrets are not included. Static-only hosting cannot run the `/api/jev/action` proxy.

## TypeSafe references

Integration follows the [HTTP API](https://docs.typesafe.ai/api), [Choice primitive](https://docs.typesafe.ai/primitives/choice), [state guidance](https://docs.typesafe.ai/concepts/state) and [function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling).
