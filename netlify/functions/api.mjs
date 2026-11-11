// Edu Tap API on Netlify Functions, with scores in Netlify Blobs.
// Same endpoints and rules as server.js: /api/join, /api/tap, /api/leaderboard.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import challenges from "../../shared/challenges.js";

const REP_BONUS = 10;
const MAX_TAPS_PER_SEC = 15;
const MAX_IDLE_SEC = 5;
const TAPS_PER_REP_MIN = 12;
const BOARD_SIZE = 50;
const BOARD_CACHE_MS = 2000;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function cleanName(raw) {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Warm function instances reuse this for a moment, so polling clients don't re-read every player each time.
let boardCache = { at: 0, list: null };

async function allPlayers(store) {
  if (boardCache.list && Date.now() - boardCache.at < BOARD_CACHE_MS) return boardCache.list;
  const { blobs } = await store.list({ prefix: "players/" });
  const list = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }))))
    .filter(Boolean)
    .sort((a, b) => b.credits - a.credits || a.joinedAt - b.joinedAt);
  boardCache = { at: Date.now(), list };
  return list;
}

async function authed(store, body) {
  const p = typeof body.id === "string" && /^[0-9a-f-]{36}$/.test(body.id) ? await store.get(`players/${body.id}`, { type: "json" }) : null;
  return p && typeof body.token === "string" && sha(body.token) === p.tokenHash ? p : null;
}

const row = (p, rank) => ({ rank, name: p.name, credits: p.credits, reps: p.reps });

export async function handle(req, store) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/\/+$/, "");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (req.method === "POST" && route === "/api/join") {
    const name = cleanName(body.name);
    if (name.length < 2 || name.length > 16) return json(400, { error: "Nickname must be 2–16 characters." });
    const nameKey = `names/${sha(name.toLowerCase())}`;
    if (await store.get(nameKey)) return json(409, { error: "That nickname is taken. Try another one." });
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString("hex");
    const now = Date.now();
    await store.set(nameKey, id);
    await store.setJSON(`players/${id}`, { id, name, credits: 0, reps: 0, taps: 0, joinedAt: now, lastSync: now, tokenHash: sha(token) });
    boardCache.at = 0;
    return json(200, { id, token, name });
  }

  if (req.method === "POST" && (route === "/api/challenge/start" || route === "/api/challenge/finish")) {
    const p = await authed(store, body);
    if (!p) return json(401, { error: "Unknown player." });
    const r = route.endsWith("/start") ? challenges.start(p, body.ch, Date.now()) : challenges.finish(p, body, Date.now(), await allPlayers(store));
    await store.setJSON(`players/${p.id}`, p);
    boardCache.at = 0;
    return json(r.status, r.body);
  }

  if (req.method === "GET" && route === "/api/challenges") {
    return json(200, challenges.overview(await allPlayers(store), url.searchParams.get("id"), Date.now()));
  }

  if (req.method === "POST" && route === "/api/tap") {
    const p = await authed(store, body);
    if (!p) return json(401, { error: "Unknown player." });
    const now = Date.now();
    const elapsed = Math.max(0, now - p.lastSync) / 1000;
    const allowed = Math.ceil(Math.min(elapsed, MAX_IDLE_SEC) * MAX_TAPS_PER_SEC) + 5;
    const taps = Math.min(Math.max(0, Math.floor(Number(body.taps) || 0)), allowed);
    const repRoom = Math.max(0, Math.floor((p.taps + taps) / TAPS_PER_REP_MIN) - p.reps);
    const reps = Math.min(Math.max(0, Math.floor(Number(body.reps) || 0)), repRoom);
    p.taps += taps;
    p.reps += reps;
    p.credits += taps + reps * REP_BONUS;
    p.lastSync = now;
    await store.setJSON(`players/${p.id}`, p);
    return json(200, { credits: p.credits, reps: p.reps, accepted: taps });
  }

  if (req.method === "GET" && route === "/api/leaderboard") {
    const me = url.searchParams.get("id");
    const list = await allPlayers(store);
    const meIndex = list.findIndex((p) => p.id === me);
    return json(200, {
      players: list.length,
      top: list.slice(0, BOARD_SIZE).map((p, i) => ({ ...row(p, i + 1), me: p.id === me })),
      me: meIndex >= 0 ? row(list[meIndex], meIndex + 1) : null,
    });
  }

  return json(404, { error: "Not found" });
}

export default async (req) => {
  try {
    return await handle(req, getStore({ name: "edutap", consistency: "strong" }));
  } catch {
    return json(500, { error: "Server error" });
  }
};

export const config = { path: "/api/*" };
