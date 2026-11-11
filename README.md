# Edu Tap

Mobile web game: every tap replays the push-up clip from frame 1, so fast taps make him "clap".
+1 credit per tap, +10 rep bonus every 15 taps. Shared leaderboard, no login (nickname only).

## Run

    npm start          # http://localhost:3100
    PORT=8080 npm start

No dependencies. Leaderboard is saved to `data/db.json` (gitignored).
To play from phones on the same Wi-Fi, open `http://<your-mac-ip>:3100`.

## Rules (server-side)

- Nickname 2–16 characters, unique (case-insensitive)
- Each player gets a secret token stored in the browser; only that browser can add to its score
- Max 15 taps per second accepted; reps capped by taps
- Reset the leaderboard: stop the server and delete `data/db.json`

## Challenges

A third tab with four daily challenges, all played on the same clip:

- **10s Blitz**: as many taps as possible in 10 seconds
- **Beat Drop**: tap on the beat (approach ring + metronome); tempo rises every 8 beats; 3 misses and you're out
- **Freeze!**: tap on green, stop on red; one tap on red ends the run; lights flip faster over time
- **Blind Count**: hit a random target (15–40) with the counter hidden

Each challenge has 3 star thresholds. Every star pays 15 credits, once per day per challenge (resets at midnight WIB).
One challenge per day is featured and pays double. Each challenge has its own top-5 board.

Rules live in `shared/challenges.js` and are used by both `server.js` and the Netlify function.
The server starts each run, checks elapsed time against the score (15 taps/s cap, beat count cap, 10 s minimum for Blitz),
picks the Blind Count target itself, and accepts each run only once.

## Media

The clip is played as JPG frames on a canvas (instant restart on every tap) with Web Audio for sound.
Regenerate after replacing `source/pushup.mp4`:

    ffmpeg -i source/pushup.mp4 -vf "fps=30,scale=480:-2" -q:v 5 public/media/frames/f%03d.jpg
    ffmpeg -y -i source/pushup.mp4 -vn -ac 1 -b:a 96k public/media/pushup.mp3

Then update `count` in `public/media/frames/manifest.json`.

## Deploy on Netlify

Connect the repo in Netlify; `netlify.toml` does the rest:

- Publishes `public/` (no build step)
- `netlify/functions/api.mjs` serves `/api/*` and stores scores in Netlify Blobs (store `edutap`), no database to set up

The local `server.js` (`npm start`) uses `data/db.json` instead; the two leaderboards are separate.
