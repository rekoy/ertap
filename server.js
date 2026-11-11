// Edu Tap: static files + a tiny JSON leaderboard API. No dependencies.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const challenges = require("./shared/challenges");

const PORT = Number(process.env.PORT) || 3100;
const PUBLIC = path.join(__dirname, "public");
const DB_FILE = path.join(__dirname, "data", "db.json");

const REP_BONUS = 10;
const MAX_TAPS_PER_SEC = 15; // generous for fast fingers, blocks scripts
const MAX_IDLE_SEC = 5;
const TAPS_PER_REP_MIN = 12; // the client needs 15; a little slack
const BOARD_SIZE = 50;

// ---------- storage ----------
let db = { players: {} };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
} catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 500);
}

function ranked() {
  return Object.entries(db.players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => b.credits - a.credits || a.joinedAt - b.joinedAt);
}

function publicRow(p, rank) {
  return { rank, name: p.name, credits: p.credits, reps: p.reps };
}

// ---------- helpers ----------
function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function cleanName(raw) {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function auth(body) {
  const p = db.players[body.id];
  if (!p || typeof body.token !== "string") return null;
  const a = Buffer.from(p.tokenHash, "hex");
  const b = crypto.createHash("sha256").update(body.token).digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? p : null;
}

// ---------- API ----------
async function api(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/join") {
    const body = await readBody(req);
    const name = cleanName(body.name);
    if (name.length < 2 || name.length > 16) return json(res, 400, { error: "Nickname must be 2–16 characters." });
    const taken = Object.values(db.players).some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return json(res, 409, { error: "That nickname is taken. Try another one." });
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");
    db.players[id] = {
      name,
      credits: 0,
      reps: 0,
      taps: 0,
      joinedAt: Date.now(),
      lastSync: Date.now(),
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    };
    save();
    return json(res, 200, { id, token, name });
  }

  if (req.method === "POST" && url.pathname === "/api/tap") {
    const body = await readBody(req);
    const p = auth(body);
    if (!p) return json(res, 401, { error: "Unknown player." });
    const now = Date.now();
    const elapsed = Math.max(0, now - p.lastSync) / 1000;
    // Idle time only banks up to MAX_IDLE_SEC of taps, so nobody can save up a huge burst.
    const allowed = Math.ceil(Math.min(elapsed, MAX_IDLE_SEC) * MAX_TAPS_PER_SEC) + 5;
    const taps = Math.min(Math.max(0, Math.floor(Number(body.taps) || 0)), allowed);
    // One rep takes ~15 taps; lifetime reps can never exceed lifetime taps / TAPS_PER_REP_MIN.
    const repRoom = Math.max(0, Math.floor((p.taps + taps) / TAPS_PER_REP_MIN) - p.reps);
    const reps = Math.min(Math.max(0, Math.floor(Number(body.reps) || 0)), repRoom);
    p.taps += taps;
    p.reps += reps;
    p.credits += taps + reps * REP_BONUS;
    p.lastSync = now;
    save();
    return json(res, 200, { credits: p.credits, reps: p.reps, accepted: taps });
  }

  if (req.method === "POST" && (url.pathname === "/api/challenge/start" || url.pathname === "/api/challenge/finish")) {
    const body = await readBody(req);
    const p = auth(body);
    if (!p) return json(res, 401, { error: "Unknown player." });
    p.id = body.id;
    const r = url.pathname.endsWith("/start") ? challenges.start(p, body.ch, Date.now()) : challenges.finish(p, body, Date.now(), ranked());
    save();
    return json(res, r.status, r.body);
  }

  if (req.method === "GET" && url.pathname === "/api/challenges") {
    return json(res, 200, challenges.overview(ranked(), url.searchParams.get("id"), Date.now()));
  }

  if (req.method === "GET" && url.pathname === "/api/leaderboard") {
    const list = ranked();
    const top = list.slice(0, BOARD_SIZE).map((p, i) => ({ ...publicRow(p, i + 1), me: p.id === url.searchParams.get("id") }));
    const meIndex = list.findIndex((p) => p.id === url.searchParams.get("id"));
    return json(res, 200, {
      players: list.length,
      top,
      me: meIndex >= 0 ? publicRow(list[meIndex], meIndex + 1) : null,
    });
  }

  json(res, 404, { error: "Not found" });
}

// ---------- static ----------
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: "Forbidden" });

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return json(res, 404, { error: "Not found" });
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    const headers = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": /^text\/(html|css|javascript)/.test(type) ? "no-cache" : "public, max-age=3600" };

    // Safari needs byte ranges to play mp4.
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (range) {
      const start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start < 0) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return api(req, res, url).catch(() => json(res, 500, { error: "Server error" }));
    serveStatic(req, res, url);
  })
  .listen(PORT, () => {
    console.log(`Edu Tap running at http://localhost:${PORT}`);
  });
