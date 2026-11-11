(() => {
  const STORE_KEY = "edutap.player";
  const SOUND_KEY = "edutap.sound";
  const TAPS_PER_REP = 15;
  const REP_BONUS = 10;
  const COMBO_WINDOW = 450;

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString("id-ID");

  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} },
    del(key) { try { localStorage.removeItem(key); } catch {} },
  };

  let player = store.get(STORE_KEY);
  let serverCredits = 0;
  let serverReps = 0;
  let pendingTaps = 0;
  let pendingReps = 0;
  let combo = 0;
  let bestCombo = 0;
  let lastTap = 0;
  let tapsTowardRep = 0;
  let syncing = false;
  let soundOn = true;

  const stage = $("stage");
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");

  // ---------- Frames: every tap restarts the clip from frame 1 ----------
  const frames = [];
  let fps = 30;
  let playStart = -1; // performance.now() of the last tap; -1 = idle
  let drawn = -1;

  async function loadFrames() {
    const m = await fetch("/media/frames/manifest.json").then((r) => r.json());
    fps = m.fps;
    canvas.width = m.width;
    canvas.height = m.height;
    let done = 0;
    await Promise.all(
      Array.from({ length: m.count }, (_, i) => {
        const img = new Image();
        img.src = m.pattern.replace("%03d", String(i + 1).padStart(3, "0"));
        frames[i] = img;
        return img.decode().catch(() => {}).then(() => {
          done += 1;
          $("loader-fill").style.transform = `scaleX(${done / m.count})`;
          if (i === 0) draw(0);
        });
      })
    );
    stage.classList.add("loaded");
    draw(0);
  }

  function draw(i) {
    const img = frames[i];
    if (!img || !img.complete || !img.naturalWidth) return;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawn = i;
  }

  // Keep the canvas covering the stage like object-fit: cover.
  function fitCanvas() {
    const r = stage.getBoundingClientRect();
    const scale = Math.max(r.width / canvas.width, r.height / canvas.height);
    canvas.style.width = canvas.width * scale + "px";
    canvas.style.height = canvas.height * scale + "px";
  }
  new ResizeObserver(fitCanvas).observe(stage);

  // ---------- Sound: Web Audio so it restarts instantly on every tap ----------
  let audioCtx = null;
  let audioBuf = null;
  let voice = null;

  async function initAudio() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    try {
      const data = await fetch("/media/pushup.mp3").then((r) => r.arrayBuffer());
      audioBuf = await audioCtx.decodeAudioData(data);
    } catch {}
  }

  function playSound() {
    if (!soundOn || !audioCtx || !audioBuf) return;
    if (audioCtx.state === "suspended") audioCtx.resume();
    if (voice) {
      try { voice.stop(); } catch {}
    }
    voice = audioCtx.createBufferSource();
    voice.buffer = audioBuf;
    voice.connect(audioCtx.destination);
    voice.start();
  }

  // ---------- API ----------
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  // ---------- Join ----------
  async function loadPlayerCount() {
    try {
      const r = await fetch("/api/leaderboard").then((r) => r.json());
      $("join-count").textContent = r.players ? `${fmt(r.players)} player${r.players === 1 ? "" : "s"} already tapping` : "Be the first on the leaderboard!";
    } catch {}
  }

  $("join-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector("button");
    const err = $("join-error");
    const name = $("nickname").value.trim();
    if (name.length < 2) {
      err.textContent = "Nickname must be at least 2 characters.";
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    const r = await post("/api/join", { name }).catch(() => ({ ok: false, data: { error: "Can't reach the server. Try again." } }));
    btn.disabled = false;
    if (!r.ok) {
      err.textContent = r.data.error || "Something went wrong.";
      err.hidden = false;
      return;
    }
    err.hidden = true;
    player = r.data;
    store.set(STORE_KEY, player);
    startGame();
  });

  // ---------- Game ----------
  function startGame() {
    $("join").hidden = true;
    $("game").hidden = false;
    $("hud-name").textContent = player.name;
    render();
    refreshBoard();
  }

  function totalCredits() {
    return serverCredits + pendingTaps + pendingReps * REP_BONUS;
  }

  function render() {
    const el = $("credits");
    el.textContent = fmt(totalCredits());
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
    $("reps").textContent = fmt(serverReps + pendingReps);
    $("best-combo").textContent = fmt(bestCombo);
  }

  function popup(x, y, text, cls = "") {
    const f = document.createElement("span");
    f.className = "float " + cls;
    f.textContent = text;
    f.style.left = x + "px";
    f.style.top = y + "px";
    stage.appendChild(f);
    f.addEventListener("animationend", () => f.remove());
  }

  function ripple(x, y) {
    const r = document.createElement("span");
    r.className = "ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    stage.appendChild(r);
    r.addEventListener("animationend", () => r.remove());
  }

  function tap(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const now = performance.now();
    if (chal) return challengeTap(now, x, y);

    combo = now - lastTap < COMBO_WINDOW ? combo + 1 : 1;
    lastTap = now;
    bestCombo = Math.max(bestCombo, combo);
    const comboEl = $("combo");
    comboEl.textContent = `${combo}x combo`;
    comboEl.classList.toggle("show", combo >= 5);
    stage.classList.toggle("hot", combo >= 10);

    pendingTaps += 1;
    stage.classList.add("started");
    replay(now);
    popup(x, y, "+1");

    tapsTowardRep += 1;
    if (tapsTowardRep >= TAPS_PER_REP) {
      tapsTowardRep = 0;
      pendingReps += 1;
      popup(rect.width / 2, rect.height * 0.4, `REP! +${REP_BONUS}`, "rep");
      if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    }
    ripple(x, y);
    if (navigator.vibrate) navigator.vibrate(8);
    render();
  }

  function replay(now, sound = true) {
    playStart = now;
    draw(0);
    if (sound) initAudio().then(playSound);
  }

  // Pointer events cover touch and mouse; each finger counts as one tap.
  stage.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    tap(e.clientX, e.clientY);
  });
  // Keyboard players: Space or Enter on the focused stage.
  stage.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return;
      const r = stage.getBoundingClientRect();
      tap(r.left + r.width / 2, r.top + r.height / 2);
    }
  });
  stage.addEventListener("click", (e) => e.preventDefault());
  // iOS only unlocks audio on touchend, so resume there too.
  stage.addEventListener("pointerup", () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  });

  function frame(now) {
    if (playStart >= 0) {
      const i = Math.floor(((now - playStart) / 1000) * fps);
      if (i >= frames.length) {
        playStart = -1;
        draw(0); // back to the starting pose, waiting for the next tap
      } else if (i !== drawn) {
        draw(i);
      }
    }
    if (now - lastTap > COMBO_WINDOW) {
      $("combo").classList.remove("show");
      stage.classList.remove("hot");
    }
    $("rep-fill").style.transform = `scaleX(${tapsTowardRep / TAPS_PER_REP})`;
    if (chal) challengeFrame(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- Sound ----------
  const soundBtn = $("sound");
  function setSound(on) {
    soundOn = on;
    if (!on && voice) {
      try { voice.stop(); } catch {}
    }
    soundBtn.setAttribute("aria-pressed", String(on));
    soundBtn.setAttribute("aria-label", on ? "Sound on" : "Sound off");
    store.set(SOUND_KEY, on);
  }
  setSound(store.get(SOUND_KEY) !== false);
  soundBtn.addEventListener("click", () => setSound(!soundOn));

  // ---------- Sync ----------
  async function sync() {
    if (!player || syncing || (pendingTaps === 0 && pendingReps === 0)) return;
    syncing = true;
    const taps = pendingTaps;
    const reps = pendingReps;
    try {
      const r = await post("/api/tap", { id: player.id, token: player.token, taps, reps });
      if (r.status === 401) return resetPlayer();
      if (r.ok) {
        pendingTaps -= taps;
        pendingReps -= reps;
        serverCredits = r.data.credits;
        serverReps = r.data.reps;
        render();
      }
    } catch {
      // Offline: keep pending taps and retry on the next tick.
    } finally {
      syncing = false;
    }
  }
  setInterval(sync, 1500);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && player && (pendingTaps || pendingReps)) {
      const body = JSON.stringify({ id: player.id, token: player.token, taps: pendingTaps, reps: pendingReps });
      if (navigator.sendBeacon(new URL("/api/tap", location.href), new Blob([body], { type: "application/json" }))) {
        serverCredits = totalCredits();
        serverReps += pendingReps;
        pendingTaps = 0;
        pendingReps = 0;
      }
    }
  });

  function resetPlayer() {
    store.del(STORE_KEY);
    player = null;
    $("game").hidden = true;
    $("join").hidden = false;
    loadPlayerCount();
  }

  // ---------- Leaderboard ----------
  function rowHtml(p) {
    const el = document.createElement("li");
    el.className = "row" + (p.rank <= 3 ? ` top${p.rank}` : "") + (p.me ? " me" : "");
    el.innerHTML = `<span class="r">${p.rank}</span><span class="n"></span><span class="c">${fmt(p.credits)}</span>`;
    const n = el.querySelector(".n");
    n.textContent = p.name + (p.me ? " (you)" : "");
    const small = document.createElement("small");
    small.textContent = `${fmt(p.reps)} reps`;
    n.appendChild(small);
    return el;
  }

  async function refreshBoard() {
    if (!player) return;
    try {
      const r = await fetch(`/api/leaderboard?id=${encodeURIComponent(player.id)}`).then((r) => r.json());
      $("players").textContent = fmt(r.players);
      if (r.me) {
        $("hud-rank").textContent = `#${r.me.rank} of ${fmt(r.players)}`;
        if (pendingTaps === 0 && pendingReps === 0) {
          serverCredits = r.me.credits;
          serverReps = r.me.reps;
        }
      } else if (r.players >= 0 && !r.me) {
        return resetPlayer();
      }
      const board = $("board");
      board.replaceChildren(...(r.top.length ? r.top.map(rowHtml) : []));
      if (!r.top.length) board.innerHTML = '<li class="board-empty">No players yet.</li>';
      const meBox = $("board-me");
      const meInTop = r.top.some((p) => p.me);
      meBox.hidden = meInTop || !r.me;
      if (!meInTop && r.me) meBox.replaceChildren(rowHtml({ ...r.me, me: true }));
      render();
    } catch {}
  }
  setInterval(() => {
    if (document.visibilityState === "visible") refreshBoard();
  }, 4000);

  // ---------- Tabs ----------
  function showView(view) {
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t.dataset.view === view;
      t.classList.toggle("is-active", active);
      if (active) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    $("view-tap").hidden = view !== "tap";
    $("view-challenges").hidden = view !== "challenges";
    $("view-board").hidden = view !== "board";
    if (view === "board") refreshBoard();
    if (view === "challenges") refreshChallenges();
  }
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));

  // ---------- Challenges ----------
  const ICONS = { blitz: "10", beat: "♪", freeze: "■", blind: "?" };
  const HELP = {
    blitz: "Tap anywhere on the video. Every tap counts.",
    beat: "Tap when the purple ring closes on the white one. Perfect = 2 pts, good = 1.",
    freeze: "Green: tap like crazy. Red: hands off! The lights flip faster over time.",
    blind: "Tap exactly the target, then stop. It ends 1.5 s after your last tap.",
  };
  const PERFECT_MS = 75;
  const GOOD_MS = 150;
  const RED_GRACE_MS = 180;
  const BLIND_IDLE_MS = 1500;

  const gameEl = $("game");
  const big = $("ch-big");
  let chOverview = null;
  let chal = null; // the run in progress

  function bigText(text, cls = "") {
    big.className = "ch-big " + cls;
    big.textContent = text;
    void big.offsetWidth;
    big.classList.add("pop");
  }

  // Short synth blips for countdowns, beats and lights.
  function tone(freq, dur = 0.07, type = "square", vol = 0.12, at = 0) {
    if (!soundOn || !audioCtx) return;
    const t = at || audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function later(fn, ms) {
    const c = chal;
    c.timers.push(setTimeout(() => chal === c && fn(), ms));
  }

  function flash(kind) {
    stage.classList.remove("flash-good", "flash-bad");
    void stage.offsetWidth;
    stage.classList.add("flash-" + kind);
    const c = chal;
    setTimeout(() => chal === c && stage.classList.remove("flash-" + kind), 120);
  }

  function setStat(text) {
    $("ch-stat").textContent = text;
  }

  async function startChallenge(key) {
    initAudio();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    const r = await post("/api/challenge/start", { id: player.id, token: player.token, ch: key }).catch(() => null);
    if (!r || !r.ok) {
      if (r && r.status === 401) return resetPlayer();
      $("ch-meta").textContent = "Can't reach the server. Try again.";
      return;
    }
    const info = chOverview?.list.find((c) => c.key === key) || { name: key, stars: [], unit: "" };
    chal = { key, info, run: r.data.run, target: r.data.target, beat: r.data.beat, state: "countdown", taps: 0, score: 0, perfect: 0, good: 0, timers: [] };

    showView("tap");
    gameEl.classList.add("in-challenge");
    stage.classList.add("mode-" + key);
    stage.classList.toggle("timed", key === "blitz" || key === "freeze");
    $("ch-title").textContent = info.name;
    $("ch-help").textContent = HELP[key];
    $("ch-time-fill").style.transform = "scaleX(1)";
    setStat(key === "blind" ? `Target ${chal.target}` : key === "beat" ? "♥♥♥  0" : "0");
    stage.focus({ preventScroll: true });

    if (key === "beat") return beatCountIn();
    [3, 2, 1].forEach((n, i) => later(() => { bigText(String(n)); tone(660); }, i * 650));
    later(() => { tone(1320, 0.15); go(); }, 1950);
  }

  function go() {
    const now = performance.now();
    chal.state = "live";
    chal.t0 = now;
    if (chal.key === "blitz") {
      chal.ends = now + chal.info.seconds * 1000;
      bigText("GO!");
    } else if (chal.key === "freeze") {
      chal.ends = now + chal.info.seconds * 1000;
      setLight("green");
    } else if (chal.key === "blind") {
      chal.lastTap = 0;
      bigText(`TAP ${chal.target}`, "small");
    }
  }

  // ----- Freeze! -----
  function setLight(color) {
    chal.light = color;
    chal.lightAt = performance.now();
    stage.classList.toggle("light-green", color === "green");
    stage.classList.toggle("light-red", color === "red");
    bigText(color === "green" ? "PUSH!" : "FREEZE!", "small");
    if (color === "green") tone(880, 0.12, "triangle", 0.2);
    else {
      tone(160, 0.35, "sawtooth", 0.14);
      if (navigator.vibrate) navigator.vibrate(60);
    }
    // The lights flip faster as the run goes on, down to half the wait.
    const speed = 1 - Math.min(0.5, (performance.now() - chal.t0) / 60000);
    const wait = color === "green" ? 1300 + Math.random() * 2400 : 700 + Math.random() * 1500;
    later(() => chal.state === "live" && setLight(color === "green" ? "red" : "green"), wait * speed);
  }

  // ----- Beat Drop -----
  function bpmAt(n) {
    const b = chal.beat;
    return Math.min(b.maxBpm, b.startBpm + Math.floor(n / b.everyBeats) * b.stepBpm);
  }

  function beatCountIn() {
    const iv = 60000 / chal.beat.startBpm;
    const first = performance.now() + 500;
    chal.lives = chal.beat.lives;
    chal.times = [first + 4 * iv];
    chal.resolved = [];
    chal.cur = 0;
    chal.scheduled = 0;
    chal.streak = 0;
    ["3", "2", "1", "GO!"].forEach((t, i) => later(() => { bigText(t); tone(i < 3 ? 660 : 1320); }, 500 + i * iv));
    later(() => { chal.state = "live"; chal.t0 = performance.now(); big.textContent = ""; }, 500 + 4 * iv - GOOD_MS);
  }

  function beatStat() {
    setStat(`${"♥".repeat(chal.lives)}${"♡".repeat(chal.beat.lives - chal.lives)}  ${chal.score}`);
  }

  function beatMiss(text) {
    chal.lives -= 1;
    chal.streak = 0;
    flash("bad");
    bigText(text, "small");
    tone(140, 0.18, "sawtooth", 0.12);
    if (navigator.vibrate) navigator.vibrate(40);
    beatStat();
    if (chal.lives <= 0) endChallenge("OUT!");
  }

  function beatFrame(now) {
    const times = chal.times;
    while (times[times.length - 1] < now + 1500) times.push(times[times.length - 1] + 60000 / bpmAt(times.length));
    // Schedule metronome clicks on the audio clock so they stay tight.
    if (audioCtx) {
      while (times[chal.scheduled] < now + 150) {
        const n = chal.scheduled;
        tone(n % 4 === 0 ? 1560 : 1040, 0.05, "square", 0.1, audioCtx.currentTime + Math.max(0, times[n] - now) / 1000);
        chal.scheduled += 1;
      }
    }
    if (chal.state !== "live") return;
    while (chal.resolved[chal.cur]) chal.cur += 1;
    if (now > times[chal.cur] + GOOD_MS) {
      chal.resolved[chal.cur] = true;
      chal.cur += 1;
      beatMiss("MISS");
      if (!chal || chal.state !== "live") return;
    }
    const t = times[chal.cur];
    const prev = chal.cur > 0 ? times[chal.cur - 1] : t - 60000 / bpmAt(0);
    const p = Math.min(1, Math.max(0, (now - prev) / (t - prev)));
    $("ch-ring").firstElementChild.style.transform = `scale(${2 - p})`;
  }

  function beatTap(now) {
    const times = chal.times;
    let k = chal.cur;
    while (chal.resolved[k]) k += 1;
    if (Math.abs(now - times[k + 1]) < Math.abs(now - times[k])) k += 1;
    const dt = Math.abs(now - times[k]);
    if (dt > GOOD_MS) return beatMiss("OFF BEAT");
    chal.resolved[k] = true;
    const perfect = dt <= PERFECT_MS;
    chal.score += perfect ? 2 : 1;
    chal[perfect ? "perfect" : "good"] += 1;
    chal.streak += 1;
    flash("good");
    replay(now, false);
    tone(perfect ? 1760 : 1320, 0.05, "triangle", 0.12);
    bigText(perfect ? (chal.streak >= 8 ? `PERFECT x${chal.streak}` : "PERFECT") : "GOOD", "small");
    // Call out each tempo jump.
    if ((k + 1) % chal.beat.everyBeats === 0 && bpmAt(k + 1) > bpmAt(k)) later(() => bigText("FASTER!", "small"), 200);
    beatStat();
  }

  // ----- Shared tap + frame hooks -----
  function challengeTap(now, x, y) {
    ripple(x, y);
    if (chal.state !== "live") return;
    if (navigator.vibrate) navigator.vibrate(8);

    if (chal.key === "beat") return beatTap(now);

    if (chal.key === "freeze" && chal.light === "red" && now - chal.lightAt > RED_GRACE_MS) {
      chal.caught = true;
      flash("bad");
      return endChallenge("CAUGHT!");
    }

    chal.taps += 1;
    replay(now);
    if (chal.key === "blind") {
      chal.lastTap = now;
      big.textContent = "";
      return;
    }
    popup(x, y, "+1");
    setStat(fmt(chal.taps));
  }

  function challengeFrame(now) {
    if (chal.state === "done") return;
    if (chal.key === "beat") return beatFrame(now);
    if (chal.state !== "live") return;
    if (chal.ends) {
      const left = Math.max(0, chal.ends - now);
      $("ch-time-fill").style.transform = `scaleX(${left / (chal.info.seconds * 1000)})`;
      if (left === 0) endChallenge(chal.key === "freeze" ? "SURVIVED!" : "TIME!");
    } else if (chal.key === "blind" && chal.lastTap && now - chal.lastTap > BLIND_IDLE_MS) {
      endChallenge("DONE!");
    }
  }

  async function endChallenge(text) {
    const c = chal;
    if (!c || c.state === "done") return;
    c.state = "done";
    c.timers.forEach(clearTimeout);
    stage.classList.remove("light-green", "light-red");
    bigText(text, "small");
    tone(text === "CAUGHT!" || text === "OUT!" ? 120 : 990, 0.4, "triangle", 0.15);
    const [r] = await Promise.all([
      post("/api/challenge/finish", { id: player.id, token: player.token, run: c.run, taps: c.taps, score: c.score }).catch(() => null),
      new Promise((ok) => setTimeout(ok, 900)),
    ]);
    if (chal !== c) return;
    showResult(c, r);
  }

  function exitChallenge() {
    if (chal) chal.timers.forEach(clearTimeout);
    chal = null;
    gameEl.classList.remove("in-challenge");
    stage.classList.remove("mode-blitz", "mode-beat", "mode-freeze", "mode-blind", "timed", "light-green", "light-red", "flash-good", "flash-bad");
    big.textContent = "";
    $("result").hidden = true;
  }

  const TITLES = ["Keep going!", "Nice!", "Great!", "LEGENDARY!"];

  function showResult(c, r) {
    const d = r && r.ok ? r.data : null;
    $("res-title").textContent = d ? TITLES[d.stars] : "Couldn't save";
    $("res-kicker").textContent = d ? (d.newBest && d.score > 0 ? "New personal best!" : d.rank ? `#${d.rank} on ${c.info.name}` : c.info.name) : c.info.name;
    $("res-score").textContent = d ? fmt(d.score) : "–";
    $("res-unit").textContent = c.info.unit;

    let detail = "";
    if (c.key === "blind" && d) detail = d.taps === d.target ? `Exactly ${d.target}. Unreal.` : `You tapped ${d.taps}. The target was ${d.target}.`;
    if (c.key === "freeze") detail = c.caught ? "Caught moving on red!" : "You survived all 30 seconds!";
    if (c.key === "beat") detail = `${c.perfect} perfect · ${c.good} good`;
    if (c.key === "blitz" && d) detail = `${(d.score / c.info.seconds).toFixed(1)} taps per second`;
    if (!d) detail = (r && r.data && r.data.error) || "Can't reach the server. Your run wasn't saved.";
    $("res-detail").textContent = detail;

    const stars = d ? d.stars : 0;
    $("res-stars").setAttribute("aria-label", `${stars} of 3 stars`);
    $("res-stars").replaceChildren(...[0, 1, 2].map((i) => {
      const s = document.createElement("span");
      s.textContent = "★";
      if (i < stars) {
        s.className = "on";
        s.style.animationDelay = `${150 + i * 180}ms`;
      }
      return s;
    }));

    let reward = "";
    if (d && d.reward) reward = `+${fmt(d.reward)} credits${d.double ? "  (2× today!)" : ""}`;
    else if (d && stars < 3) reward = `Next star at ${fmt(c.info.stars[stars])} ${c.info.unit}`;
    else if (d) reward = "All 3 stars already claimed today";
    $("res-reward").textContent = reward;

    $("res-top").replaceChildren(...(d ? d.top : []).map((p) => {
      const li = document.createElement("li");
      li.className = p.me ? "me" : "";
      li.innerHTML = `<span class="r">${p.rank}</span><span class="n"></span><span class="s">${fmt(p.score)}</span>`;
      li.querySelector(".n").textContent = p.name + (p.me ? " (you)" : "");
      return li;
    }));

    if (d) {
      serverCredits = d.credits;
      render();
      if (stars === 3 || (d.newBest && d.score > 0)) confetti();
    }
    $("result").hidden = false;
    $("res-again").focus({ preventScroll: true });
  }

  function confetti() {
    const box = $("confetti");
    const colors = ["#FFD23F", "#FF5A5F", "#3DDC97", "#9B8CFF", "#F7F8FC"];
    for (let i = 0; i < 70; i++) {
      const p = document.createElement("i");
      p.style.left = Math.random() * 100 + "%";
      p.style.background = colors[i % colors.length];
      p.style.setProperty("--dx", (Math.random() * 160 - 80).toFixed(0) + "px");
      p.style.setProperty("--rot", (Math.random() * 900 - 450).toFixed(0) + "deg");
      p.style.animationDuration = 1.6 + Math.random() * 1.4 + "s";
      p.style.animationDelay = Math.random() * 0.4 + "s";
      p.addEventListener("animationend", () => p.remove());
      box.appendChild(p);
    }
  }

  $("ch-quit").addEventListener("click", () => {
    exitChallenge();
    showView("challenges");
  });
  $("res-again").addEventListener("click", () => {
    const key = chal ? chal.key : null;
    exitChallenge();
    if (key) startChallenge(key);
  });
  $("res-back").addEventListener("click", () => {
    exitChallenge();
    showView("challenges");
  });

  function starsHtml(n) {
    return `<span class="stars" aria-label="${n} of 3 stars today">${[0, 1, 2].map((i) => `<span class="${i < n ? "on" : ""}">★</span>`).join("")}</span>`;
  }

  async function refreshChallenges() {
    if (!player) return;
    try {
      chOverview = await fetch(`/api/challenges?id=${encodeURIComponent(player.id)}`).then((r) => r.json());
    } catch {
      $("ch-meta").textContent = "Can't reach the server. Try again.";
      return;
    }
    const o = chOverview;
    $("ch-meta").textContent = `Each ★ pays ${o.starCredits} credits, once a day per challenge. Resets at midnight WIB.`;
    $("ch-list").replaceChildren(...o.list.map((c) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      const hot = c.key === o.featured;
      b.type = "button";
      b.className = "ch-card" + (hot ? " featured" : "");
      b.innerHTML = `<span class="ch-icon ${c.key}" aria-hidden="true">${ICONS[c.key]}</span>
        <span>
          <span class="ch-name"><span class="nm"></span>${hot ? '<span class="ch-x2">2× TODAY</span>' : ""}</span>
          <span class="ch-tag"></span>
          <span class="ch-meta">${starsHtml(c.starsToday)}<span>Best <b>${c.me ? fmt(c.me.score) : "–"}</b></span><span class="rec"></span></span>
          <span class="ch-goals">★ ${c.stars.map(fmt).join(" · ")} ${c.unit}</span>
        </span>`;
      b.querySelector(".nm").textContent = c.name;
      b.querySelector(".ch-tag").textContent = c.tagline;
      const rec = c.top[0];
      b.querySelector(".rec").textContent = rec ? `Record: ${rec.name} (${fmt(rec.score)})` : "No record yet. Claim it!";
      b.addEventListener("click", () => startChallenge(c.key));
      li.appendChild(b);
      return li;
    }));
  }

  // ---------- Boot ----------
  loadFrames();
  if (player && player.id && player.token) startGame();
  else loadPlayerCount();
})();
