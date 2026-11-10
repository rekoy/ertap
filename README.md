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

## Media

The clip is played as JPG frames on a canvas (instant restart on every tap) with Web Audio for sound.
Regenerate after replacing `source/pushup.mp4`:

    ffmpeg -i source/pushup.mp4 -vf "fps=30,scale=480:-2" -q:v 5 public/media/frames/f%03d.jpg
    ffmpeg -y -i source/pushup.mp4 -vn -ac 1 -b:a 96k public/media/pushup.mp3

Then update `count` in `public/media/frames/manifest.json`.
