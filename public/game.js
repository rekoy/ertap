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

    combo = now - lastTap < COMBO_WINDOW ? combo + 1 : 1;
    lastTap = now;
    bestCombo = Math.max(bestCombo, combo);
    const comboEl = $("combo");
    comboEl.textContent = `${combo}x combo`;
    comboEl.classList.toggle("show", combo >= 5);
    stage.classList.toggle("hot", combo >= 10);

    pendingTaps += 1;
    stage.classList.add("started");
    playStart = now;
    draw(0);
    initAudio().then(playSound);
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
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        if (active) t.setAttribute("aria-current", "page");
        else t.removeAttribute("aria-current");
      });
      const view = tab.dataset.view;
      $("view-tap").hidden = view !== "tap";
      $("view-board").hidden = view !== "board";
      if (view === "board") refreshBoard();
    });
  });

  // ---------- Boot ----------
  loadFrames();
  if (player && player.id && player.token) startGame();
  else loadPlayerCount();
})();
