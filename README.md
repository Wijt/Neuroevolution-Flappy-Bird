# Neuroevolution-Flappy-Bird
 Creating a genius flappy bird!

## Run

Requires Node.js 20 or newer.

```sh
npm install
cp .env.example .env      # then set TYPESAFE_API_KEY in .env
npm start
```

Open http://localhost:3000.

The server serves the static game and proxies `POST /api/jev` to TypeSafe, so the
API key stays on the server and is never sent to the browser. `.env` is git-ignored.

Offline calibration of the Jev prompt vocabulary:

```sh
npm run calibrate
```

### Docker

```sh
docker build -t flappy-jev .
docker run --rm -p 3000:3000 -e TYPESAFE_API_KEY=your-key flappy-jev
```
