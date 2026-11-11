// Challenge rules shared by server.js and the Netlify function, so both judge runs the same way.
// Works on plain player objects: { id, name, credits, best, daily, run, ... }.
const crypto = require("node:crypto");

const MAX_TAPS_PER_SEC = 15;
const STAR_CREDITS = 15;
const RUN_TTL_SEC = 10 * 60;
const TOP_SIZE = 5;

// Beat Drop tempo: starts slow, speeds up every few beats.
const BEAT = { startBpm: 84, stepBpm: 6, everyBeats: 8, maxBpm: 168, lives: 3 };

const CHALLENGES = {
  blitz: {
    name: "10s Blitz",
    tagline: "Tap as fast as you can for 10 seconds.",
    unit: "taps",
    stars: [50, 75, 100],
    seconds: 10,
  },
  beat: {
    name: "Beat Drop",
    tagline: "Tap on the beat. It gets faster. 3 misses and you're out.",
    unit: "pts",
    stars: [20, 45, 70],
  },
  freeze: {
    name: "Freeze!",
    tagline: "Tap on green. Freeze on red. One tap on red and you're out.",
    unit: "taps",
    stars: [80, 140, 200],
    seconds: 30,
  },
  blind: {
    name: "Blind Count",
    tagline: "Hit the target number exactly. The counter is hidden.",
    unit: "%",
    stars: [70, 90, 100],
  },
};
const KEYS = Object.keys(CHALLENGES);

// Days roll over at midnight Jakarta time (WIB, UTC+7).
const dayKey = (now) => new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
const featured = (day) => KEYS[crypto.createHash("sha256").update("edutap:" + day).digest()[0] % KEYS.length];
const starsFor = (ch, score) => CHALLENGES[ch].stars.filter((s) => score >= s).length;
const int = (v) => Math.max(0, Math.floor(Number(v) || 0));

// Most beats Beat Drop can have played after `sec` seconds.
function beatsIn(sec) {
  let t = 0;
  let n = 0;
  while (t <= sec && n < 10_000) {
    const bpm = Math.min(BEAT.maxBpm, BEAT.startBpm + Math.floor(n / BEAT.everyBeats) * BEAT.stepBpm);
    t += 60 / bpm;
    n += 1;
  }
  return n;
}

function start(p, ch, now) {
  if (!CHALLENGES[ch]) return { status: 400, body: { error: "Unknown challenge." } };
  p.run = { id: crypto.randomUUID(), ch, startedAt: now };
  if (ch === "blind") p.run.target = 15 + crypto.randomInt(26); // 15–40
  return { status: 200, body: { run: p.run.id, ch, target: p.run.target ?? null, beat: ch === "beat" ? BEAT : null } };
}

function finish(p, body, now, players) {
  const run = p.run;
  if (!run || run.id !== body.run) return { status: 409, body: { error: "This challenge run has expired. Start again." } };
  p.run = null;
  const c = CHALLENGES[run.ch];
  const sec = (now - run.startedAt) / 1000;
  if (sec > RUN_TTL_SEC) return { status: 409, body: { error: "This challenge run has expired. Start again." } };
  const taps = Math.min(int(body.taps), Math.ceil(sec * MAX_TAPS_PER_SEC) + 5);

  let score;
  if (run.ch === "blitz") {
    if (sec < c.seconds) return { status: 422, body: { error: "Run ended too early." } };
    score = Math.min(taps, c.seconds * MAX_TAPS_PER_SEC + 5);
  } else if (run.ch === "freeze") {
    score = Math.min(taps, (c.seconds + 1) * MAX_TAPS_PER_SEC);
  } else if (run.ch === "beat") {
    score = Math.min(int(body.score), 2 * beatsIn(sec) + 2);
  } else {
    score = Math.max(0, 100 - 10 * Math.abs(taps - run.target));
  }

  const stars = starsFor(run.ch, score);
  const prev = p.best?.[run.ch]?.score ?? -1;
  const newBest = score > 0 && score > prev;
  p.best = p.best || {};
  if (newBest) p.best[run.ch] = { score, at: now };

  // Stars pay out once per day per challenge; only the stars you didn't already have today.
  const day = dayKey(now);
  if (!p.daily || p.daily.day !== day) p.daily = { day, stars: {} };
  const gained = Math.max(0, stars - (p.daily.stars[run.ch] || 0));
  const double = featured(day) === run.ch;
  const reward = gained * STAR_CREDITS * (double ? 2 : 1);
  if (gained) p.daily.stars[run.ch] = stars;
  p.credits += reward;

  const board = boardFor(run.ch, players.map((x) => (x.id === p.id ? p : x)), p.id);
  return {
    status: 200,
    body: { ch: run.ch, score, taps, target: run.target ?? null, stars, newBest, best: Math.max(score, prev), reward, double, credits: p.credits, top: board.top, rank: board.me?.rank ?? null },
  };
}

function boardFor(ch, players, meId) {
  const list = players
    .filter((p) => p.best?.[ch])
    .sort((a, b) => b.best[ch].score - a.best[ch].score || a.best[ch].at - b.best[ch].at);
  const row = (p, i) => ({ rank: i + 1, name: p.name, score: p.best[ch].score, me: p.id === meId });
  const meIndex = list.findIndex((p) => p.id === meId);
  return { top: list.slice(0, TOP_SIZE).map(row), me: meIndex >= 0 ? row(list[meIndex], meIndex) : null, players: list.length };
}

// Everything the Challenges tab needs in one response.
function overview(players, meId, now) {
  const day = dayKey(now);
  const me = players.find((p) => p.id === meId);
  const today = me?.daily?.day === day ? me.daily.stars : {};
  return {
    day,
    featured: featured(day),
    starCredits: STAR_CREDITS,
    list: KEYS.map((key) => {
      const b = boardFor(key, players, meId);
      return { key, ...CHALLENGES[key], top: b.top, me: b.me, players: b.players, starsToday: today[key] || 0 };
    }),
  };
}

module.exports = { CHALLENGES, BEAT, start, finish, overview, starsFor, beatsIn, dayKey, featured };
