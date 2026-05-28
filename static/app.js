/* ============================================================
   Woodrower Trainer – frontend
   ============================================================ */

// ---------- utility ----------
const $  = (q, el = document) => el.querySelector(q);
const $$ = (q, el = document) => [...el.querySelectorAll(q)];

const fmtTime = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};
const fmtPace = (sp500) => {
  if (sp500 == null || sp500 <= 0 || sp500 > 9999) return "–";
  const m = Math.floor(sp500 / 60), s = Math.round(sp500 % 60);
  return `${m}:${String(s).padStart(2,"0")}`;
};
const fmtDistance = (m) => {
  if (!m) return "0 m";
  return m >= 1000 ? (m/1000).toFixed(2).replace(".", ",") + " km" : m + " m";
};
const fmtDate = (iso) => {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
};
const colorForPct = (level) => {
  if (level <= 5)  return "var(--blue)";
  if (level <= 10) return "var(--green)";
  return "var(--orange)";
};
const hexColor = (() => {
  const cache = {};
  return cssVar => {
    if (cssVar in cache) return cache[cssVar];
    const tmp = document.createElement("span");
    tmp.style.color = cssVar;
    document.body.appendChild(tmp);
    const c = getComputedStyle(tmp).color;
    document.body.removeChild(tmp);
    return (cache[cssVar] = c);
  };
})();
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

// ---------- BLE state + overlay ----------
const bleState = { connected: false };

function showBleOverlay(reason = "connecting") {
  const overlay = document.getElementById("ble-overlay");
  const msg     = document.getElementById("ble-overlay-msg");
  if (!overlay) return;
  if (reason === "no_address") {
    msg.innerHTML = `Kein Gerät konfiguriert.<br>
      <small>Bitte zuerst im <b>Admin</b>-Bereich die Bluetooth-Adresse eintragen.</small>`;
  } else {
    msg.textContent = "Verbinde mit Rudergerät…";
  }
  overlay.hidden = false;
}

function hideBleOverlay() {
  const overlay = document.getElementById("ble-overlay");
  if (overlay) overlay.hidden = true;
}

async function requestBleConnect() {
  if (bleState.connected) return;
  showBleOverlay("connecting");
  try {
    await fetch("/api/ble/connect", { method: "POST" });
  } catch (e) {
    console.warn("ble connect request failed", e);
  }
}

document.getElementById("btn-ble-cancel").onclick = () => {
  hideBleOverlay();
  showView("list");
  fetch("/api/ble/disconnect", { method: "POST" }).catch(() => {});
};

// ---------- view switch ----------
function showView(name) {
  $$("section[id^=view-]").forEach(s => s.hidden = (s.id !== "view-" + name));
  const navName = name === "session" ? "history" : name;
  $$("header nav button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === navName)
  );
  document.body.classList.toggle("view-dashboard", name === "dashboard");
  if (name === "list")      renderList();
  if (name === "dashboard") drawChart();
  if (name === "history")   renderHistory();
  if (name === "admin")     renderAdmin();
}
$$("header nav button").forEach(b =>
  b.onclick = () => showView(b.dataset.view)
);

// ---------- API ----------
async function apiListWorkouts() {
  const r = await fetch("/api/workouts");
  return await r.json();
}
async function apiSaveWorkout(name, w) {
  await fetch("/api/workouts/" + encodeURIComponent(name), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(w),
  });
}
async function apiDeleteWorkout(name) {
  await fetch("/api/workouts/" + encodeURIComponent(name), { method: "DELETE" });
}
async function apiStartSession(workoutName, snapshot) {
  const r = await fetch("/api/sessions/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workout_name: workoutName, workout_snapshot: snapshot }),
  });
  if (!r.ok) { console.warn("session start failed", await r.text()); return null; }
  return (await r.json()).id;
}
async function apiPauseSession(id)  { if (id != null) await fetch(`/api/sessions/${id}/pause`,  {method:"POST"}); }
async function apiResumeSession(id) { if (id != null) await fetch(`/api/sessions/${id}/resume`, {method:"POST"}); }
async function apiStopSession(id, completed) {
  if (id == null) return;
  await fetch(`/api/sessions/${id}/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: !!completed }),
  });
}
async function apiSetResistance(level) {
  await fetch("/api/resistance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level }),
  });
}
async function apiGetResistance() {
  const r = await fetch("/api/resistance");
  return await r.json();
}
async function apiStats(days = 365) {
  const r = await fetch(`/api/stats?days=${days}`);
  return await r.json();
}
async function apiListSessions(limit = 50) {
  const r = await fetch(`/api/sessions?limit=${limit}`);
  return await r.json();
}
async function apiGetSession(id) {
  const r = await fetch(`/api/sessions/${id}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
async function apiDeleteSession(id) {
  await fetch(`/api/sessions/${id}`, { method: "DELETE" });
}
async function apiPatchSessionEnergy(id, data) {
  await fetch(`/api/sessions/${id}/energy`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ---------- list view ----------
async function renderList() {
  const workouts = await apiListWorkouts();
  const list = $("#workout-list");
  list.innerHTML = "";
  const names = Object.keys(workouts);
  if (!names.length) {
    list.innerHTML = `<div class="card" style="text-align:center;color:var(--muted)">
      Noch keine Trainings. Klick auf <b>+ Neues Training</b>
      oder starte ein <b>Freies Training</b>.</div>`;
    return;
  }
  for (const name of names) {
    const w = workouts[name];
    const total = workoutTotalSeconds(w);
    const card = document.createElement("div");
    card.className = "workout-card";
    card.innerHTML = `
      <canvas class="mini-chart"></canvas>
      <div>
        <h3>${escapeHtml(name)}</h3>
        <div class="meta">${fmtTime(total)} · ${Number(w.repeat_count) || 0}× ${
          (w.steps || []).length} Schritte</div>
      </div>
      <div class="spacer"></div>
      <button data-act="start">▶ Start</button>
      <button class="ghost" data-act="edit">Bearbeiten</button>
      <button class="danger" data-act="delete">Löschen</button>
    `;
    card.querySelector('[data-act=start]').onclick  = () => startWorkout(name, w);
    card.querySelector('[data-act=edit]').onclick   = () => openEditor(name, w);
    card.querySelector('[data-act=delete]').onclick = async () => {
      if (!confirm(`"${name}" löschen?`)) return;
      await apiDeleteWorkout(name);
      renderList();
    };
    list.appendChild(card);
    requestAnimationFrame(() => drawMiniChart(card.querySelector(".mini-chart"), w));
  }
}

function workoutTotalSeconds(w) {
  const steps    = w.steps || [];
  const reps     = w.repeat_count || 0;
  const skip     = Math.min(w.last_rep_skip_steps || 0, steps.length);
  const stepSum  = steps.reduce((s, st) => s + (st.duration_s || 0), 0);
  const lastSum  = steps.slice(0, steps.length - skip).reduce((s, st) => s + (st.duration_s || 0), 0);
  const repSecs  = reps > 1 ? (reps - 1) * stepSum + lastSum : lastSum;
  return (w.start?.duration_s || 0) + (w.end?.duration_s || 0) + repSecs;
}

function expandWorkout(w) {
  const out  = [];
  const skip = Math.min(w.last_rep_skip_steps || 0, (w.steps || []).length);
  if (w.start?.duration_s > 0)
    out.push({ ...w.start, label: "Start", kind: "start" });
  const reps = w.repeat_count || 0;
  for (let i = 0; i < reps; i++) {
    const isLast  = i === reps - 1;
    const steps   = isLast && skip > 0 ? (w.steps || []).slice(0, -skip) : (w.steps || []);
    for (const [si, s] of steps.entries()) {
      if (s.duration_s > 0)
        out.push({ ...s, label: `Wdh. ${i+1}`, kind: "rep", stepIdx: si, repIdx: i, rep_comment: w.rep_comment || "" });
    }
  }
  if (w.end?.duration_s > 0)
    out.push({ ...w.end, label: "Ende", kind: "end" });
  return out;
}

// ---------- editor ----------
let editingName = null;

function wireSlider(rangeEl, valEl) {
  const update = () => { valEl.textContent = rangeEl.value; recalcEditorDuration(); };
  rangeEl.addEventListener("input", update);
  update();
}
function recalcEditorDuration() {
  const startDur = +$("#ed-start-dur").value || 0;
  const endDur   = +$("#ed-end-dur").value   || 0;
  const reps     = +$("#ed-reps-count").value || 1;
  const stepSum  = $$("#ed-rep-steps .segment").reduce((s, r) =>
    s + (+r.querySelector(".dur").value || 0), 0);
  const total = startDur + endDur + reps * stepSum;
  $("#ed-total-time").textContent = fmtTime(total);
  drawEditorPreview();
}

function drawEditorPreview(hoverSegIdx = null) {
  const canvas = $("#ed-preview");
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
  if (!cssW || !cssH) return;
  canvas.width  = cssW * dpr; canvas.style.width  = cssW + "px";
  canvas.height = cssH * dpr; canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const w = {
    start: { duration_s: +$("#ed-start-dur").value || 0, resistance_pct: +$("#ed-start-w").value || 0, comment: $("#ed-start-comment").value.trim() },
    repeat_count:        +$("#ed-reps-count").value    || 1,
    last_rep_skip_steps: +$("#ed-last-rep-skip").value || 0,
    rep_comment:          $("#ed-rep-comment").value.trim(),
    steps: $$("#ed-rep-steps .segment").map(r => ({
      duration_s:     +r.querySelector(".dur").value || 0,
      resistance_pct: +r.querySelector(".w").value  || 0,
      comment:         r.querySelector(".comment-input")?.value.trim() || "",
    })),
    end: { duration_s: +$("#ed-end-dur").value || 0, resistance_pct: +$("#ed-end-w").value || 0, comment: $("#ed-end-comment").value.trim() },
  };
  const segs = expandWorkout(w);
  const totalT = segs.reduce((s, x) => s + x.duration_s, 0);
  if (!segs.length || !totalT) return;

  const padL = 36, padR = 8, padT = 10, padB = 20;
  const W = cssW - padL - padR, H = cssH - padT - padB;
  const maxPct = 15;
  const xOfT   = t   => padL + (t / totalT) * W;
  const yOfPct = val => padT + H - (val / maxPct) * H;

  canvas._edSegs   = segs;
  canvas._edLayout = { padL, W, H, padT, totalT, cssW };

  // grid lines
  ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (H * i) / 4;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
  }

  // axes
  ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + H + 1);
  ctx.lineTo(padL + W, padT + H + 1); ctx.stroke();

  // y-axis labels
  ctx.fillStyle = "#9ba2af"; ctx.font = "10px system-ui"; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (H * i) / 4;
    ctx.fillText(Math.round(maxPct * (1 - i / 4)), padL - 4, y + 3);
  }

  // bars
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const x0  = xOfT(acc), x1 = xOfT(acc + seg.duration_s);
    const pct = seg.resistance_pct ?? 0;
    const y   = yOfPct(pct);
    const isHov = i === hoverSegIdx;
    ctx.fillStyle   = hexColor(colorForPct(pct));
    ctx.globalAlpha = isHov ? 1 : (hoverSegIdx != null ? 0.45 : 0.85);
    ctx.fillRect(x0 + 1, y, Math.max(2, x1 - x0 - 2), padT + H - y);
    if (isHov) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(x0 + 1.5, y + 0.5, Math.max(2, x1 - x0 - 3), padT + H - y - 1);
    }
    ctx.globalAlpha = 1;
    acc += seg.duration_s;
  }

  // x-axis time labels
  const step = totalT > 30 * 60 ? 600 : totalT > 10 * 60 ? 300 : 60;
  ctx.fillStyle = "#9ba2af"; ctx.font = "10px system-ui"; ctx.textAlign = "center";
  for (let t = 0; t <= totalT; t += step) {
    ctx.fillText(fmtTime(t).replace(/^0:/, ""), xOfT(t), padT + H + 14);
  }

  // tooltip
  if (hoverSegIdx != null && hoverSegIdx < segs.length) {
    const seg    = segs[hoverSegIdx];
    const tStart = segs.slice(0, hoverSegIdx).reduce((s, x) => s + x.duration_s, 0);
    const tEnd   = tStart + seg.duration_s;
    const pct    = seg.resistance_pct ?? 0;
    const fmt    = t => fmtTime(t).replace(/^0:/, "");
    const cx     = xOfT((tStart + tEnd) / 2);
    const cy     = yOfPct(pct);
    const commentParts = [seg.rep_comment, seg.comment].filter(Boolean);
    const line1  = `${fmt(tStart)} – ${fmt(tEnd)}  ·  ${fmt(seg.duration_s)}  ·  Stufe ${pct}`;
    const line2  = commentParts.join(" / ");
    ctx.font = "bold 11px system-ui";
    const tw1 = ctx.measureText(line1).width;
    ctx.font = "11px system-ui";
    const tw2 = line2 ? ctx.measureText(line2).width : 0;
    const tw = Math.max(tw1, tw2) + 14;
    const th = line2 ? 34 : 18;
    const tx = Math.max(padL, Math.min(cssW - 8 - tw, cx - tw / 2));
    const ty = Math.max(padT + 2, cy - th - 8);
    ctx.fillStyle   = "rgba(255,255,255,0.96)";
    ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#1a1a2e"; ctx.textAlign = "left";
    ctx.font = "bold 11px system-ui";
    ctx.fillText(line1, tx + 7, ty + 13);
    if (line2) {
      ctx.font = "11px system-ui"; ctx.fillStyle = "#555e6e";
      ctx.fillText(line2, tx + 7, ty + 28);
    }
  }
}

function drawMiniChart(canvas, workout) {
  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvas.offsetWidth;
  const cssH = canvas.offsetHeight;
  if (!cssW || !cssH) return;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  const segs   = expandWorkout(workout);
  const totalT = segs.reduce((s, x) => s + x.duration_s, 0);
  if (!segs.length || !totalT) return;
  const maxPct = 15, pad = 2;
  const W = cssW - 2 * pad, H = cssH - 2 * pad;
  let acc = 0;
  for (const seg of segs) {
    const x0   = pad + (acc / totalT) * W;
    const x1   = pad + ((acc + seg.duration_s) / totalT) * W;
    const pct  = seg.resistance_pct ?? 0;
    const barH = Math.max(2, (pct / maxPct) * H);
    ctx.fillStyle   = hexColor(colorForPct(pct));
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x0 + 0.5, pad + H - barH, Math.max(1, x1 - x0 - 1), barH);
    acc += seg.duration_s;
  }
  ctx.globalAlpha = 1;
}

function _edSegmentEl(seg) {
  if (seg.kind === "start") return $("#ed-start-row")?.closest("fieldset");
  if (seg.kind === "end")   return $("#ed-end-row")?.closest("fieldset");
  if (seg.kind === "rep")   return $$("#ed-rep-steps .segment")[seg.stepIdx] ?? null;
  return null;
}

function _attachEditorPreviewHover() {
  const canvas = $("#ed-preview");
  if (!canvas || canvas._edHoverOn) return;
  canvas._edHoverOn = true;

  canvas.addEventListener("mousemove", e => {
    const segs = canvas._edSegs, lay = canvas._edLayout;
    if (!segs || !lay) return;
    const mx = e.clientX - canvas.getBoundingClientRect().left;
    const t  = (mx - lay.padL) / lay.W * lay.totalT;
    let acc = 0, found = null;
    for (let i = 0; i < segs.length; i++) {
      if (t >= acc && t < acc + segs[i].duration_s) { found = i; break; }
      acc += segs[i].duration_s;
    }
    if (found !== canvas._edHoverIdx) {
      canvas._edHoverIdx = found;
      drawEditorPreview(found);
      document.querySelectorAll(".ed-highlight").forEach(el => el.classList.remove("ed-highlight"));
      if (found != null) { const el = _edSegmentEl(segs[found]); if (el) el.classList.add("ed-highlight"); }
    }
  });

  canvas.addEventListener("click", () => {
    const idx  = canvas._edHoverIdx;
    const segs = canvas._edSegs;
    if (idx == null || !segs) return;
    canvas._edClickedIdx = idx;
    const el = _edSegmentEl(segs[idx]);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  canvas.addEventListener("mouseleave", () => {
    canvas._edHoverIdx = null;
    drawEditorPreview(null);
    document.querySelectorAll(".ed-highlight").forEach(el => el.classList.remove("ed-highlight"));
    if (canvas._edClickedIdx != null && canvas._edSegs) {
      const el = _edSegmentEl(canvas._edSegs[canvas._edClickedIdx]);
      if (el) el.classList.add("ed-highlight");
    }
  });
}

function openEditor(name, w) {
  editingName = name;
  $("#editor-title").textContent = name ? "Training bearbeiten" : "Neues Training";
  $("#ed-name").value = name || "";
  const W = w || {
    start: { duration_s: 180, resistance_pct: 3 },
    steps: [
      { duration_s: 60, resistance_pct: 5 }, { duration_s: 30, resistance_pct: 8 },
      { duration_s: 60, resistance_pct: 5 }, { duration_s: 60, resistance_pct: 3 },
    ],
    repeat_count: 5,
    end: { duration_s: 180, resistance_pct: 3 },
  };
  // legacy workouts used "watts" — fall back gracefully
  const rPct = (s) => Math.min(s?.resistance_pct ?? s?.watts ?? 0, 15);
  $("#ed-start-dur").value     = W.start?.duration_s ?? 0;
  $("#ed-start-w").value       = rPct(W.start);
  $("#ed-start-comment").value = W.start?.comment   || "";
  $("#ed-end-dur").value       = W.end?.duration_s  ?? 0;
  $("#ed-end-w").value         = rPct(W.end);
  $("#ed-end-comment").value   = W.end?.comment     || "";
  $("#ed-reps-count").value         = W.repeat_count          || 1;
  $("#ed-last-rep-skip").value      = W.last_rep_skip_steps   || 0;
  $("#ed-rep-comment").value        = W.rep_comment           || "";
  $("#ed-rep-steps").innerHTML = "";
  (W.steps || []).forEach(s => addStepRow({
    duration_s: s.duration_s, resistance_pct: rPct(s), comment: s.comment || "",
  }));
  wireSlider($("#ed-start-w"), $("#ed-start-w-val"));
  wireSlider($("#ed-end-w"),   $("#ed-end-w-val"));
  recalcEditorDuration();
  showView("editor");
  requestAnimationFrame(() => {
    const c = $("#ed-preview");
    if (c) c._edClickedIdx = null;
    drawEditorPreview();
    _attachEditorPreviewHover();
  });
}

function addStepRow(step = { duration_s: 60, resistance_pct: 5, comment: "" }) {
  const value = Math.min(step.resistance_pct ?? 1, 15);
  const row = document.createElement("div");
  row.className = "segment";
  row.innerHTML = `
    <div>
      <label>Dauer (Sek.)</label>
      <input type="number" min="0" class="dur" value="${step.duration_s}" />
    </div>
    <div>
      <label>Intensität</label>
      <div class="slider-grp">
        <input type="range" min="1" max="15" value="${value}" class="w" />
        <span class="w-val">${value}</span>
      </div>
    </div>
    <button class="x" title="entfernen">✕</button>
    <div class="comment-wrap">
      <input type="text" class="comment-input" placeholder="Kommentar …" value="${escapeHtml(step.comment || "")}" />
    </div>
  `;
  row.querySelector(".x").onclick = () => { row.remove(); recalcEditorDuration(); };
  wireSlider(row.querySelector(".w"), row.querySelector(".w-val"));
  row.querySelector(".dur").addEventListener("input", recalcEditorDuration);
  $("#ed-rep-steps").appendChild(row);
  recalcEditorDuration();
}

$("#ed-start-dur").addEventListener("input", recalcEditorDuration);
$("#ed-end-dur").addEventListener("input",   recalcEditorDuration);
$("#ed-reps-count").addEventListener("input",    recalcEditorDuration);
$("#ed-last-rep-skip").addEventListener("input", recalcEditorDuration);

$("#btn-new").onclick      = () => openEditor(null, null);
$("#btn-add-step").onclick = () => addStepRow();
$("#btn-cancel").onclick   = () => showView("list");

$("#btn-save").onclick = async () => {
  const name = $("#ed-name").value.trim();
  if (!name) { alert("Bitte einen Namen vergeben."); return; }
  const w = {
    start: {
      duration_s:     +$("#ed-start-dur").value || 0,
      resistance_pct: +$("#ed-start-w").value   || 0,
      comment:        $("#ed-start-comment").value.trim(),
    },
    repeat_count:        +$("#ed-reps-count").value    || 1,
    last_rep_skip_steps: +$("#ed-last-rep-skip").value || 0,
    rep_comment:          $("#ed-rep-comment").value.trim(),
    steps: $$("#ed-rep-steps .segment").map(r => ({
      duration_s:     +r.querySelector(".dur").value          || 0,
      resistance_pct: +r.querySelector(".w").value            || 0,
      comment:        r.querySelector(".comment-input")?.value.trim() || "",
    })),
    end: {
      duration_s:     +$("#ed-end-dur").value || 0,
      resistance_pct: +$("#ed-end-w").value   || 0,
      comment:        $("#ed-end-comment").value.trim(),
    },
  };
  if (editingName && editingName !== name) await apiDeleteWorkout(editingName);
  await apiSaveWorkout(name, w);
  showView("list");
};


// ---------- beep ----------
let _audioCtx = null;
function playBeep(freq = 880, dur = 0.08) {
  try {
    if (!_audioCtx || _audioCtx.state === "closed")
      _audioCtx = new AudioContext();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const osc  = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + dur);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + dur);
  } catch (e) {}
}

// ---------- dashboard ----------
const dash = {
  workoutName: null,
  workoutDef:  null,
  segments:    [],
  totalSec:    0,
  freeMode:    false,
  running:     false,
  startedAt:   null,
  pausedAt:    null,
  pausedAcc:   0,
  strokes:     [],
  last:        {},
  sums:        { watt: 0, spm: 0, spmN: 0, n: 0, paceN: 0, paceSum: 0, hrN: 0, hrSum: 0 },
  sessionId:   null,
  userId:      null,
  completedNotified: false,
  currentSegIdx: -1,
  autoStartPending: false,
  beepedKeys:  new Set(),
};

function setDashboardMode(free) {
  dash.freeMode = free;
  $("#chart-wrap").hidden       = free;
  $("#resistance-wrap").hidden  = !free;
  $("#d-period-label").textContent = free ? "Live-Werte" : "Aktuelle Periode";
  $("#d-period-rem").style.display       = free ? "none" : "";
  $("#d-total-label").textContent = free ? "Verstrichene Zeit" : "Gesamt-Restzeit";
}

function populateDashUserSelect() {
  const sel = $("#d-user-select");
  const users = loadUsers();
  const activeId = getActiveUserId();
  sel.innerHTML = users.length
    ? users.map(u => `<option value="${u.id}"${u.id === activeId ? " selected" : ""}>${escapeHtml(u.name || "–")}</option>`).join("")
    : `<option value="">– kein Benutzer –</option>`;
  sel.disabled = false;
}

function startWorkout(name, w) {
  if (dash.sessionId != null) apiStopSession(dash.sessionId, false);
  dash.workoutName = name;
  dash.workoutDef  = w;
  dash.segments = expandWorkout(w);
  dash.totalSec = dash.segments.reduce((s, x) => s + x.duration_s, 0);
  resetDashState();
  setDashboardMode(false);
  populateDashUserSelect();
  $("#d-title").textContent = name;
  $("#btn-startstop").textContent = "▶";
  $("#btn-startstop").disabled = false;
  showView("dashboard");
  updateDashboard();
  requestBleConnect();
}

function startFreeTraining() {
  if (dash.sessionId != null) apiStopSession(dash.sessionId, false);
  dash.workoutName = "Freies Training";
  dash.workoutDef  = null;
  dash.segments = [];
  dash.totalSec = 0;
  resetDashState();
  setDashboardMode(true);
  populateDashUserSelect();
  $("#d-title").textContent = "Freies Training";
  $("#btn-startstop").textContent = "▶";
  $("#btn-startstop").disabled = false;
  showView("dashboard");
  updateDashboard();
  requestBleConnect();
}

function resetDashState() {
  dash.running = false;
  dash.startedAt = null;
  dash.pausedAt = null;
  dash.pausedAcc = 0;
  dash.strokes = [];
  dash.last = {};
  dash.sums = { watt: 0, spm: 0, spmN: 0, n: 0, paceN: 0, paceSum: 0, hrN: 0, hrSum: 0 };
  dash.completedNotified = false;
  dash.sessionId = null;
  dash.userId    = null;
  dash.currentSegIdx = -1;
  dash.autoStartPending = false;
  dash.beepedKeys = new Set();
}

async function autoStartSession() {
  if (dash.startedAt || dash.autoStartPending) return;
  dash.autoStartPending = true;
  dash.userId = $("#d-user-select").value || null;
  $("#d-user-select").disabled = true;
  const snapshot = dash.freeMode ? null : dash.workoutDef;
  const sid = await apiStartSession(dash.workoutName, snapshot);
  if (sid == null) { dash.autoStartPending = false; return; }
  dash.sessionId = sid;
  dash.startedAt = performance.now();
  dash.running = true;
  dash.autoStartPending = false;
  $("#btn-startstop").textContent = "⏸";
  const initPct = dash.freeMode
    ? parseInt($("#d-resistance-slider").value || "8", 10)
    : (dash.segments[0]?.resistance_pct ?? 8);
  apiSetResistance(initPct);
}

function elapsedSec() {
  if (!dash.startedAt) return 0;
  if (!dash.running) return (dash.pausedAt - dash.startedAt - dash.pausedAcc) / 1000;
  return (performance.now() - dash.startedAt - dash.pausedAcc) / 1000;
}

function currentSegmentAt(t) {
  let acc = 0;
  for (const s of dash.segments) {
    if (t < acc + s.duration_s) return { seg: s, segStart: acc, segElapsed: t - acc };
    acc += s.duration_s;
  }
  return null;
}

$("#btn-startstop").onclick = async () => {
  if (!dash.startedAt && !dash.autoStartPending) {
    await autoStartSession();
  } else if (dash.running) {
    dash.running = false;
    dash.pausedAt = performance.now();
    apiPauseSession(dash.sessionId);
  } else {
    dash.pausedAcc += performance.now() - dash.pausedAt;
    dash.running = true;
    apiResumeSession(dash.sessionId);
  }
  $("#btn-startstop").textContent = dash.running ? "⏸" : "▶";
};


$("#btn-back").onclick = async () => {
  if (dash.sessionId != null) {
    const completed = dash.freeMode
      ? elapsedSec() > 5
      : (dash.totalSec > 0 && elapsedSec() >= dash.totalSec);
    recordSessionEnergy(dash.sessionId, dash.userId);
    await apiStopSession(dash.sessionId, completed);
    dash.sessionId = null;
  }
  showView("list");
};

// ---------- resistance slider ----------
async function initResistance() {
  try {
    const r = await apiGetResistance();
    if (r.level != null) {
      $("#d-resistance-slider").value = r.level;
      $("#d-resistance-val").textContent = r.level;
    }
    const ticksEl = $("#d-resistance-ticks");
    ticksEl.innerHTML = "";
    for (let i = 1; i <= 15; i++) {
      const s = document.createElement("span");
      s.textContent = i;
      ticksEl.appendChild(s);
    }
  } catch (e) { /* no rower yet */ }
}
let resistanceDebounce;
$("#d-resistance-slider").addEventListener("input", e => {
  const v = +e.target.value;
  $("#d-resistance-val").textContent = v;
  clearTimeout(resistanceDebounce);
  resistanceDebounce = setTimeout(() => apiSetResistance(v), 120);
});
initResistance();

// ---------- live WebSocket ----------
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    setInterval(() => { try { ws.send("ping"); } catch {} }, 25000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "status") {
      bleState.connected = !!msg.connected;
      $("#status").classList.toggle("on", !!msg.connected);
      $("#status .text").textContent = msg.connected
        ? (msg.address === "SIM" ? "Simulation" : "verbunden")
        : "getrennt";
      if (msg.connected) {
        hideBleOverlay();
        if (!dash.startedAt && !dash.autoStartPending
            && !document.getElementById("view-dashboard").hidden) {
          autoStartSession();
        }
      } else if (msg.error === "no_address") {
        showBleOverlay("no_address");
      }
    } else if (msg.type === "rower") {
      onRowerData(msg);
    } else if (msg.type === "resistance") {
      const level = msg.level ?? 1;
      $("#d-resistance-val").textContent = level;
      $("#d-resistance-slider").value = level;
    }
  };
  ws.onclose = () => {
    $("#status").classList.remove("on");
    $("#status .text").textContent = "getrennt";
    setTimeout(connectWS, 2000);
  };
}
function onRowerData(m) {
  dash.last = m;
  if (!dash.startedAt && !dash.autoStartPending
      && !document.getElementById("view-dashboard").hidden
      && (m.spm > 0 || m.power > 0)) {
    autoStartSession();
  }
  if (dash.running && dash.startedAt) {
    const t = elapsedSec();
    if (m.power != null) {
      dash.strokes.push({ t_sec: t, watts: m.power });
      if (dash.strokes.length > 5000) dash.strokes.splice(0, 1000);
    }
    if (m.power != null) { dash.sums.watt += m.power; dash.sums.n += 1; }
    if (m.spm  != null) { dash.sums.spm += m.spm; dash.sums.spmN += 1; }
    if (m.pace != null) { dash.sums.paceSum += m.pace; dash.sums.paceN += 1; }
    if (m.hr   != null) { dash.sums.hrSum += m.hr; dash.sums.hrN += 1; }
  }
}
connectWS();

// ---------- dashboard tick ----------
function updateDashboard() {
  if (document.getElementById("view-dashboard").hidden) {
    requestAnimationFrame(updateDashboard);
    return;
  }
  const t = elapsedSec();

  if (dash.freeMode) {
    $("#d-total-rem").textContent = fmtTime(t);
  } else {
    const remaining = Math.max(0, dash.totalSec - t);
    $("#d-total-rem").textContent = fmtTime(remaining);

    if (!dash.completedNotified && dash.sessionId != null
        && dash.totalSec > 0 && t >= dash.totalSec) {
      dash.completedNotified = true;
      recordSessionEnergy(dash.sessionId, dash.userId);
      apiStopSession(dash.sessionId, true);
      dash.sessionId = null;
      dash.running = false;
      dash.pausedAt = performance.now();
      $("#btn-startstop").textContent = "✓";
      $("#btn-startstop").disabled = true;
    }

    const here = currentSegmentAt(t);
    if (here) {
      const pct = here.seg.resistance_pct ?? here.seg.watts ?? 0;
      const segIdx = dash.segments.indexOf(here.seg);
      if (segIdx !== dash.currentSegIdx) {
        dash.currentSegIdx = segIdx;
        if (dash.running) apiSetResistance(pct);
      }
      const rem = here.seg.duration_s - here.segElapsed;
      if (dash.running) {
        const remFloor = Math.floor(rem);
        if (remFloor >= 1 && remFloor <= 3) {
          const key = `${segIdx}-${remFloor}`;
          if (!dash.beepedKeys.has(key)) {
            dash.beepedKeys.add(key);
            playBeep();
          }
        }
      }
      $("#d-period-rem").textContent = fmtTime(rem);
      $("#d-period-w").textContent   = pct;
      $("#d-period-swatch").style.background = hexColor(colorForPct(pct));

      const parts = [here.seg.rep_comment, here.seg.comment].filter(Boolean);
      $("#d-period-comment").textContent = parts.join(" · ") || "–";

      const repEl = $("#d-rep-counter");
      if (repEl) {
        if (here.seg.kind === "rep" && dash.workoutDef) {
          repEl.textContent = `${(here.seg.repIdx ?? 0) + 1} / ${dash.workoutDef.repeat_count || "?"}`;
        } else {
          repEl.textContent = here.seg.label || "–";
        }
      }
    } else {
      $("#d-period-rem").textContent = "–";
      $("#d-period-w").textContent   = "–";
      $("#d-period-comment").textContent = "–";
      const repEl = $("#d-rep-counter");
      if (repEl) repEl.textContent = "–";
    }

    const progressPct = dash.totalSec > 0 ? Math.min(100, (t / dash.totalSec) * 100) : 0;
    const ppEl = $("#d-progress-pct");
    if (ppEl) ppEl.textContent = Math.round(progressPct) + "%";
    const pfEl = $("#d-progress-fill");
    if (pfEl) pfEl.style.width = progressPct + "%";
  }

  $("#d-dist").textContent = dash.last.distance ?? 0;
  $("#d-watt").textContent = dash.last.power ?? 0;
  $("#d-pace").textContent = fmtPace(dash.last.pace);
  $("#d-spm").textContent  = dash.last.spm   ?? 0;
  $("#d-hr").textContent   = dash.last.hr   ?? "–";
  const N = dash.sums.n || 1;
  $("#d-watt-avg").textContent = Math.round(dash.sums.watt / N);
  $("#d-spm-avg").textContent  = dash.sums.spmN ? Math.round(dash.sums.spm / dash.sums.spmN) : "–";
  $("#d-pace-avg").textContent = dash.sums.paceN
      ? fmtPace(dash.sums.paceSum / dash.sums.paceN) : "–";
  $("#d-hr-avg").textContent   = dash.sums.hrN
      ? Math.round(dash.sums.hrSum / dash.sums.hrN) : "–";

  if (!dash.freeMode) drawChart(t);
  requestAnimationFrame(updateDashboard);
}

// ---------- chart resize observer ----------
{
  const chartWrap = document.getElementById("chart-wrap");
  if (chartWrap) new ResizeObserver(() => { if (!chartWrap.hidden) drawChart(elapsedSec()); }).observe(chartWrap);
}

// ---------- chart (planned mode only) ----------
function drawChart(curT = 0) {
  const canvas = $("#chart");
  if (!canvas || $("#chart-wrap").hidden) return;
  const wrap = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
  if (!cssW || !cssH) return;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  if (!dash.segments.length) {
    ctx.fillStyle = "#9ba2af";
    ctx.font = "13px system-ui";
    ctx.fillText("Kein Training geladen", 14, 24);
    return;
  }

  const hasStrokes = dash.strokes && dash.strokes.length > 0;
  const padL = 40, padR = hasStrokes ? 44 : 12, padT = 16, padB = 26;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;
  const totalT = dash.totalSec;
  const maxPct = 15;
  const xOfT    = (t)   => padL + (t / totalT) * w;
  const yOfPct  = (val) => padT + h - (val / maxPct) * h;
  const segPct  = (s)   => s.resistance_pct ?? s.watts ?? 0;

  // right axis: Watt scale derived from actual strokes
  const maxWatt = hasStrokes
    ? Math.ceil(Math.max(...dash.strokes.map(s => s.watts)) / 50) * 50
    : 0;
  const yOfWatt = (w_) => padT + h - (w_ / (maxWatt || 1)) * h;

  ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + h);
  ctx.moveTo(padL, padT + h); ctx.lineTo(padL + w, padT + h);
  ctx.stroke();
  ctx.fillStyle = "#9ba2af"; ctx.font = "11px system-ui";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (h * i) / 4;
    const val = Math.round(maxPct * (1 - i / 4));
    ctx.strokeStyle = "#eef0f4";
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
    ctx.fillText(val, 4, y + 4);
    // right axis labels
    if (hasStrokes) {
      const wVal = Math.round(maxWatt * (1 - i / 4));
      ctx.textAlign = "left";
      ctx.fillText(wVal, padL + w + 4, y + 4);
      ctx.textAlign = "left";
    }
  }
  ctx.fillText("Stufe", 4, padT - 4);
  if (hasStrokes) {
    ctx.textAlign = "left";
    ctx.fillText("W", padL + w + 4, padT - 4);
  }
  const step = totalT > 30 * 60 ? 600 : (totalT > 10 * 60 ? 300 : 60);
  for (let t = 0; t <= totalT; t += step) {
    const x = xOfT(t);
    ctx.strokeStyle = "#eef0f4";
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
    ctx.fillStyle = "#9ba2af";
    ctx.fillText(fmtTime(t).replace(/^0:/, ""), x - 12, padT + h + 14);
  }

  let acc = 0;
  for (const seg of dash.segments) {
    const x0  = xOfT(acc);
    const x1  = xOfT(acc + seg.duration_s);
    const pct = segPct(seg);
    const y   = yOfPct(pct);
    ctx.fillStyle = hexColor(colorForPct(pct));
    ctx.fillRect(x0 + 1, y, Math.max(2, x1 - x0 - 2), padT + h - y);
    acc += seg.duration_s;
  }

  // draw power line
  if (hasStrokes && maxWatt > 0) {
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.85)";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let first = true;
    for (const s of dash.strokes) {
      if (s.t_sec > totalT) break;
      const sx = xOfT(s.t_sec);
      const sy = yOfWatt(s.watts);
      if (first) { ctx.moveTo(sx, sy); first = false; }
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.restore();
    // right axis line
    ctx.strokeStyle = "rgba(59,130,246,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL + w, padT);
    ctx.lineTo(padL + w, padT + h);
    ctx.stroke();
  }

  if (curT > 0 && curT <= totalT) {
    const x = xOfT(curT);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "#374151";
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + h); ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------- history view ----------
async function renderHistory() {
  let stats, sessions;
  try {
    [stats, sessions] = await Promise.all([apiStats(0), apiListSessions(10000)]);
  } catch (e) {
    $("#sessions-list").innerHTML =
      `<div class="empty-hint">Konnte Verlauf nicht laden.</div>`;
    return;
  }
  // Trends loaded in parallel, non-blocking
  apiTrends().then(renderTrends).catch(() => {
    document.getElementById("trends-card").hidden = true;
    document.getElementById("trends-profile-card").hidden = true;
  });
  // tiles
  $("#t-sessions").textContent  = stats.totals.sessions;
  $("#t-distance").textContent  = fmtDistance(stats.totals.distance_m);
  $("#t-duration").textContent  = fmtTime(stats.totals.duration_s);
  $("#t-avg-power").textContent = stats.totals.avg_power != null
    ? Math.round(stats.totals.avg_power) + " W" : "–";
  // bests
  $("#b-max-power").textContent    = stats.bests.max_power != null
    ? stats.bests.max_power + " W" : "–";
  $("#b-max-distance").textContent = stats.bests.max_distance != null
    ? fmtDistance(stats.bests.max_distance) : "–";
  $("#b-max-duration").textContent = stats.bests.max_duration_s != null
    ? fmtTime(stats.bests.max_duration_s) : "–";
  $("#b-best-pace").textContent    = stats.bests.best_pace != null
    ? fmtPace(stats.bests.best_pace) + " /500 m" : "–";
  // averages
  $("#a-power").textContent  = stats.totals.avg_power != null
    ? Math.round(stats.totals.avg_power) + " W" : "–";
  $("#a-pace").textContent   = stats.totals.avg_pace != null
    ? fmtPace(stats.totals.avg_pace) + " /500 m" : "–";
  $("#a-spm").textContent    = stats.totals.avg_spm != null
    ? stats.totals.avg_spm.toFixed(1) + " spm" : "–";
  // Sum total_kcal from DB; fall back to localStorage for sessions without DB energy
  const _smeta = loadSessionMeta();
  const _dbKcal = sessions.reduce((sum, s) => sum + (s.total_kcal || 0), 0);
  const _lsKcal = _dbKcal === 0
    ? Object.values(_smeta).reduce((sum, m) => sum + (m.total_kcal || 0), 0)
    : 0;
  const _totalKcal = _dbKcal + _lsKcal;
  $("#a-energy").textContent = _totalKcal > 0
    ? _totalKcal + " kcal"
    : (stats.totals.energy_kcal ? stats.totals.energy_kcal + " kcal" : "–");

  renderHeatmap(stats.daily);
  renderWeekdayHeatmap(stats.daily);
  renderMonthHeatmap(stats.daily);
  renderRecentSessions(sessions);
}

function renderHeatmap(daily) {
  const el = $("#heatmap");
  if (!daily.length) {
    el.innerHTML = '<div class="empty-hint">Noch keine Aktivitäten.</div>';
    return;
  }

  const map = Object.fromEntries(daily.map(d => [d.day, d]));
  const maxMinutes = Math.max(...daily.map(d => d.duration_s / 60), 1);
  const today = new Date(); today.setHours(0, 0, 0, 0);

  // Start at the first day of the first activity's month
  const firstActive = new Date(daily[0].day + "T00:00:00");
  const startDate   = new Date(firstActive.getFullYear(), firstActive.getMonth(), 1);

  // Build list of months from startDate through the current month (inclusive)
  const endMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const months = [];
  let cur = new Date(startDate);
  while (cur <= endMonth) {
    months.push(new Date(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }

  const cellSize = 12, gap = 3, step = cellSize + gap;
  const padL = 26, padT = 18;

  // Pre-calculate column layout: each month occupies its weeks, then one gap column
  let colOffset = 0;
  const monthMeta = months.map(m => {
    const fw = (new Date(m.getFullYear(), m.getMonth(), 1).getDay() + 6) % 7;
    const daysCount = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((fw + daysCount) / 7);
    const startCol = colOffset;
    colOffset += weeks + 1; // +1 gap column after each month
    return { month: m, fw, daysCount, startCol };
  });
  const totalCols = colOffset - 1; // trim trailing gap

  const svgW = padL + totalCols * step;
  const svgH = padT + 7 * step;

  const cells = [], lbls = [];
  let prevYear = -1;

  for (const { month, fw, daysCount, startCol } of monthMeta) {
    const year = month.getFullYear();
    const mo   = month.getMonth();
    const x0   = padL + startCol * step;

    // Month label — include year when it changes
    const monName = month.toLocaleString("de-DE", { month: "short" });
    const lbl = (year !== prevYear) ? `${monName} ${year}` : monName;
    lbls.push(`<text x="${x0}" y="12" fill="#6b7280" font-size="10">${lbl}</text>`);
    prevYear = year;

    for (let d = 1; d <= daysCount; d++) {
      const date = new Date(year, mo, d);
      if (date > today) continue;
      const dow     = (date.getDay() + 6) % 7; // 0=Mo … 6=So
      const weekIdx = Math.floor((fw + d - 1) / 7);
      const cx = padL + (startCol + weekIdx) * step;
      const cy = padT + dow * step;
      // Build date string without UTC conversion
      const dayStr = `${year}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const data = map[dayStr];
      const minutes = data ? data.duration_s / 60 : 0;
      const color = _sideHeatmapColor(minutes / maxMinutes);
      const title = data
        ? `<title>${escapeHtml(`${dayStr}\n${data.sessions} Training(s) · ${fmtTime(data.duration_s)} · ${fmtDistance(data.distance_m)}`)}</title>`
        : "";
      cells.push(`<rect x="${cx}" y="${cy}" width="${cellSize}" height="${cellSize}" fill="${color}" rx="2" data-day="${dayStr}" style="cursor:pointer">${title}</rect>`);
    }
  }

  // All 7 weekday labels
  const dowLabels = ["Mo","Di","Mi","Do","Fr","Sa","So"].map((l, i) =>
    `<text x="0" y="${padT + i * step + cellSize - 2}" fill="#6b7280" font-size="10">${l}</text>`
  ).join("");

  el.innerHTML = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="min-width:${svgW}px">
    ${lbls.join("")}${dowLabels}${cells.join("")}
  </svg>`;

  el.querySelector("svg").addEventListener("click", e => {
    const day = e.target.getAttribute("data-day");
    selectHeatmapDay(day || null);
  });
}

function selectHeatmapDay(day) {
  $$(".session-row.hm-active").forEach(r => r.classList.remove("hm-active"));
  if (!day) return;
  const rows = $$(`#sessions-list .session-row[data-day="${day}"]`);
  if (!rows.length) return;
  rows.forEach(r => r.classList.add("hm-active"));
  rows[0].scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderRecentSessions(sessions) {
  const el = $("#sessions-list");
  if (!sessions || !sessions.length) {
    el.innerHTML = `<div class="empty-hint">Noch keine abgeschlossenen Trainings.</div>`;
    return;
  }

  // Group by year-month (sessions arrive newest-first)
  const groups = [];
  let currentKey = null;
  for (const s of sessions) {
    const d = new Date(s.started_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (key !== currentKey) {
      currentKey = key;
      const label = d.toLocaleString("de-DE", { month: "long", year: "numeric" });
      groups.push({ label, items: [] });
    }
    groups[groups.length - 1].items.push(s);
  }

  const smeta = loadSessionMeta();
  const ulist = loadUsers();
  const sessionRow = s => {
    const d   = new Date(s.started_at);
    const day = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    // Prefer DB-stored values; fall back to localStorage for old sessions
    const sm       = smeta[s.id];
    const userId   = s.user_id       ?? sm?.user_id       ?? null;
    const bmrKcal  = s.bmr_kcal      ?? sm?.bmr_kcal      ?? null;
    const exKcal   = s.exercise_kcal ?? sm?.exercise_kcal ?? null;
    const totKcal  = s.total_kcal    ?? sm?.total_kcal    ?? null;
    const usr      = userId ? ulist.find(u => u.id === userId) : null;
    const energyLine = totKcal != null
      ? `<div class="session-energy-line">🔥 Grund&nbsp;<b>${bmrKcal}</b> · Training&nbsp;<b>${exKcal}</b> · ∑&nbsp;<b>${totKcal}</b>&nbsp;kcal</div>`
      : "";
    return `
    <div class="session-row" data-id="${s.id}" data-day="${day}">
      <div>
        <div class="name">${escapeHtml(s.workout_name || "Freies Training")}</div>
        <div class="when">${fmtDate(s.started_at)}${usr ? ` · <span class="session-user-tag">👤 ${escapeHtml(usr.name)}</span>` : ""}</div>
        ${energyLine}
      </div>
      <div class="stats">
        <span>${fmtTime(s.duration_s || 0)}</span>
        <span>${fmtDistance(s.total_distance || 0)}</span>
        <span>${s.avg_power != null ? Math.round(s.avg_power) : "–"}<span class="unit">W</span></span>
        ${s.completed
          ? '<span class="badge">✓ abgeschlossen</span>'
          : '<span class="badge incomplete">abgebrochen</span>'}
      </div>
    </div>`;
  };

  el.innerHTML = groups.map(({ label, items }, idx) =>
    (idx > 0 ? `<div class="session-month-spacer"></div>` : "") +
    `<div class="session-month-header">${escapeHtml(label)}</div>` +
    items.map(sessionRow).join("")
  ).join("");

  $$(".session-row", el).forEach(row =>
    row.onclick = () => showSessionDetail(+row.dataset.id)
  );
}

// ---------- session detail ----------
let _sdSamples = [];
let _sdSessionId = null;
let _sdChartMeta = {};
let _sdHoverT = null;

async function showSessionDetail(id) {
  try {
    const s = await apiGetSession(id);
    _sdSamples   = s.samples || [];
    _sdSessionId = s.id;
    for (const sp of _sdSamples) {
      sp.force = (sp.power > 0 && sp.spm > 0)
        ? Math.round(sp.power * 92.3 / sp.spm)
        : null;
    }
    renderSessionDetail(s);
    showView("session");
    requestAnimationFrame(() => redrawSessionCharts());
  } catch (e) {
    alert("Fehler beim Laden: " + e.message);
  }
}

function renderSessionDetail(s) {
  $("#sd-name").textContent = s.workout_name || "Freies Training";
  const status = s.completed ? "abgeschlossen" : "abgebrochen";

  // Prefer DB-stored energy/user; fall back to localStorage for old sessions
  const sm      = loadSessionMeta()[s.id];
  const userId  = s.user_id  ?? sm?.user_id  ?? null;
  const bmrKcal = s.bmr_kcal ?? sm?.bmr_kcal ?? null;
  const exKcal  = s.exercise_kcal ?? sm?.exercise_kcal ?? null;
  const totKcal = s.total_kcal    ?? sm?.total_kcal    ?? null;
  const usr     = userId ? loadUsers().find(u => u.id === userId) : null;
  const usrStr  = usr ? ` · 👤 ${usr.name}` : "";
  $("#sd-meta").textContent = `${fmtDate(s.started_at)} · ${fmtTime(s.duration_s || 0)} · ${status}${usrStr}`;

  // energy card
  const eCard = $("#sd-energy-card");
  const eCont = $("#sd-energy-content");
  eCard.hidden = false;
  if (totKcal && usr) {
    const wirkungsgrad = usr.efficiency ?? 22;
    eCont.innerHTML = `
      <div class="energy-grid">
        <div class="energy-cell bmr">
          <div class="elbl">Grundverbrauch</div>
          <div class="ev">${bmrKcal}</div>
          <div class="eu">kcal Ruhezustand (nach Mifflin-St-Jeor)</div>
        </div>
        <div class="energy-cell sport">
          <div class="elbl">Training</div>
          <div class="ev">${exKcal}</div>
          <div class="eu">kcal Mehrverbrauch (mit ${wirkungsgrad}% Wirkungsgrad)</div>
        </div>
        <div class="energy-cell total">
          <div class="elbl">Gesamt</div>
          <div class="ev">${totKcal}</div>
          <div class="eu">kcal gesamt</div>
        </div>
      </div>`;
  } else {
    eCont.innerHTML = `<p class="energy-nodata">Keine Energiedaten — Benutzerprofil (Gewicht, Größe, Geburtsdatum) im Admin hinterlegen.</p>`;
  }

  // Use DB-stored max values; fall back to computing from raw samples for old sessions
  let maxSpm = s.max_spm ?? null;
  let maxHr  = s.max_hr  ?? null;
  let bestPace = s.best_pace ?? null;
  if (maxSpm === null && maxHr === null && bestPace === null) {
    for (const sp of _sdSamples) {
      if (sp.spm  > 0) maxSpm   = maxSpm   === null ? sp.spm  : Math.max(maxSpm,  sp.spm);
      if (sp.hr   > 0) maxHr    = maxHr    === null ? sp.hr   : Math.max(maxHr,   sp.hr);
      if (sp.pace > 0 && sp.pace < 600)
        bestPace = bestPace === null ? sp.pace : Math.min(bestPace, sp.pace);
    }
  }

  const tile = (v, u) =>
    `<div class="tile"><div class="v">${v}</div><div class="u">${escapeHtml(u)}</div></div>`;
  const group = (lbl, ...tiles) =>
    `<div class="sd-metric-group">` +
    `<div class="sd-metric-label">${escapeHtml(lbl)}</div>` +
    `<div class="sd-metric-tiles">${tiles.join("")}</div></div>`;

  const totalKcalStr = totKcal != null ? totKcal + " kcal"
    : s.total_energy != null ? s.total_energy + " kcal" : "–";
  $("#sd-kpis").innerHTML = `<div class="sd-metric-groups">` +
    group("Summen",
      tile(fmtDistance(s.total_distance),  "Distanz"),
      tile(fmtTime(s.duration_s || 0),     "Dauer"),
      tile(totalKcalStr,                   "Gesamt kcal")) +
    group("Durchschnitt",
      tile(s.avg_power != null ? Math.round(s.avg_power) + " W"       : "–", "Leistung"),
      tile(s.avg_pace  != null ? fmtPace(s.avg_pace) + " /500m"       : "–", "Pace"),
      tile(s.avg_spm   != null ? s.avg_spm.toFixed(1) + " spm"        : "–", "SPM"),
      tile(s.avg_hr    != null ? Math.round(s.avg_hr) + " bpm"        : "–", "Herzrate")) +
    group("Maximum",
      tile(s.max_power != null ? s.max_power + " W"                   : "–", "Leistung"),
      tile(bestPace    != null ? fmtPace(bestPace) + " /500m"         : "–", "Pace"),
      tile(maxSpm      != null ? Math.round(maxSpm) + " spm"          : "–", "SPM"),
      tile(maxHr       != null ? Math.round(maxHr) + " bpm"           : "–", "Herzrate")) +
    `</div>`;

  const hasHr    = _sdSamples.some(p => p.hr    != null && p.hr    > 0);
  const hasForce = _sdSamples.some(p => p.force != null && p.force > 0);
  $("#sd-hr-card").hidden    = !hasHr;
  document.getElementById("sd-force-card").hidden = !hasForce;
}

function redrawSessionCharts(hoverT = null) {
  drawSessionChart("sd-chart-power", _sdSamples, "power", "var(--blue)",   "W",      null,    false, hoverT);
  drawSessionChart("sd-chart-pace",  _sdSamples, "pace",  "var(--green)",  "/500 m", fmtPace, true,  hoverT);
  drawSessionChart("sd-chart-spm",   _sdSamples, "spm",   "var(--orange)", "spm",    null,    false, hoverT);
  if (!$("#sd-hr-card").hidden)
    drawSessionChart("sd-chart-hr",    _sdSamples, "hr",    "var(--red)",    "bpm",    null,    false, hoverT);
  if (!document.getElementById("sd-force-card").hidden)
    drawSessionChart("sd-chart-force", _sdSamples, "force", "#8b5cf6",       "N",      null,    false, hoverT);
  drawPowerProfile(_sdSamples);
  attachHoverListeners();
  attachProfileHover();
}

// ---------- power profile ----------
const PROFILE_BINS = [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600];

function maxAvgPowerForDuration(pts, dSec) {
  if (!pts.length) return null;
  const avgInterval = pts.length > 1
    ? (pts[pts.length - 1].t_sec - pts[0].t_sec) / (pts.length - 1)
    : 5;
  let best = 0, lo = 0, sum = 0;
  for (let hi = 0; hi < pts.length; hi++) {
    sum += pts[hi].power;
    while (pts[hi].t_sec - pts[lo].t_sec > dSec) {
      sum -= pts[lo].power;
      lo++;
    }
    if (pts[hi].t_sec - pts[lo].t_sec + avgInterval >= dSec) {
      const avg = sum / (hi - lo + 1);
      if (avg > best) best = avg;
    }
  }
  return best > 0 ? best : null;
}

function drawPowerProfile(samples, hoverIdx) {
  const card   = document.getElementById("sd-power-profile-card");
  const canvas = document.getElementById("sd-chart-profile");
  if (!card || !canvas) return;

  if (hoverIdx === undefined) hoverIdx = canvas._profileHoverIdx ?? null;

  const pts = samples
    .filter(s => s.power != null && s.power > 0)
    .sort((a, b) => a.t_sec - b.t_sec);

  if (pts.length < 3) { card.hidden = true; return; }

  const sessionDur = pts[pts.length - 1].t_sec - pts[0].t_sec;
  if (sessionDur < 2) { card.hidden = true; return; }

  const results = PROFILE_BINS
    .filter(d => d <= sessionDur)
    .map(d => ({ d, watts: maxAvgPowerForDuration(pts, d) }))
    .filter(r => r.watts != null);

  if (!results.length) { card.hidden = true; return; }
  card.hidden = false;

  const padL = 44, padR = 12, padT = 18, padB = 28;
  const wrap = canvas.parentElement;
  const cssW = wrap.clientWidth || 400;
  const cssH = wrap.clientHeight || 200;
  const dpr  = window.devicePixelRatio || 1;
  canvas.width  = cssW * dpr;  canvas.style.width  = cssW + "px";
  canvas.height = cssH * dpr;  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const W = cssW - padL - padR;
  const H = cssH - padT - padB;

  const logMin = 0; // log(1)
  const logMax = Math.log(results[results.length - 1].d);
  const xOf = d => padL + (Math.log(d) - logMin) / (logMax - logMin) * W;

  const maxWatts = Math.max(...results.map(r => r.watts));
  const yOf = w => padT + H - (w / maxWatts) * H;

  const xTickLabel = t => t < 60 ? t + " s" : t < 3600 ? (t / 60) + " min" : (t / 3600) + " h";

  // Variable bar edges: midpoints in log-space between adjacent bins
  const edges = results.map((r, i) => {
    const logD = Math.log(r.d);
    const gapL = i > 0
      ? (logD - Math.log(results[i - 1].d)) / 2
      : (results.length > 1 ? (Math.log(results[1].d) - logD) / 2 : 0.4);
    const gapR = i < results.length - 1
      ? (Math.log(results[i + 1].d) - logD) / 2
      : (i > 0 ? (logD - Math.log(results[i - 1].d)) / 2 : 0.4);
    return {
      x0: padL + (logD - gapL * 0.82 - logMin) / (logMax - logMin) * W,
      x1: padL + (logD + gapR * 0.82 - logMin) / (logMax - logMin) * W,
    };
  });
  canvas._profileEdges   = edges;
  canvas._profileResults = results;

  // Y-axis grid + labels
  ctx.font = "10px system-ui"; ctx.fillStyle = "#9ba2af";
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y    = padT + H * frac;
    const val  = Math.round(maxWatts * (1 - frac));
    ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText(val, padL - 4, y + 3);
  }
  ctx.textAlign = "left"; ctx.fillText("W", padL + 4, padT - 6);

  // X-axis ticks
  const xTicks = [1, 5, 10, 30, 60, 300, 600, 1800, 3600]
    .filter(t => t >= 1 && t <= results[results.length - 1].d);
  for (const t of xTicks) {
    const x = xOf(t);
    ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + H); ctx.stroke();
    ctx.fillStyle = "#9ba2af"; ctx.font = "10px system-ui"; ctx.textAlign = "center";
    ctx.fillText(xTickLabel(t), x, padT + H + 14);
  }

  // Axes
  ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + H + 1);
  ctx.lineTo(padL + W, padT + H + 1); ctx.stroke();

  // Bars
  results.forEach((r, i) => {
    const { x0, x1 } = edges[i];
    const bw  = Math.max(2, x1 - x0);
    const by  = yOf(r.watts);
    const bh  = padT + H - by;
    const ratio  = r.watts / maxWatts;
    const colVar = ratio > 0.85 ? "var(--orange)" : ratio > 0.6 ? "var(--green)" : "var(--blue)";
    const col    = hexColor(colVar);
    const isHov  = hoverIdx === i;

    ctx.globalAlpha = isHov ? 1 : 0.72;
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.roundRect(x0, by, bw, bh, [3, 3, 0, 0]); ctx.fill();
    ctx.globalAlpha = 1;

    if (isHov) {
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(x0, by, bw, bh, [3, 3, 0, 0]); ctx.stroke();
    }
  });

  // Tooltip
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < results.length) {
    const r  = results[hoverIdx];
    const { x0, x1 } = edges[hoverIdx];
    const cx  = (x0 + x1) / 2;
    const by  = yOf(r.watts);
    const ratio  = r.watts / maxWatts;
    const colVar = ratio > 0.85 ? "var(--orange)" : ratio > 0.6 ? "var(--green)" : "var(--blue)";
    const col    = hexColor(colVar);
    const text   = `${xTickLabel(r.d)}  ·  ${Math.round(r.watts)} W`;
    ctx.font = "bold 11px system-ui";
    const tw  = ctx.measureText(text).width + 14;
    const th  = 20;
    let tx    = Math.max(padL, Math.min(cssW - padR - tw, cx - tw / 2));
    const ty  = Math.max(padT + 2, by - th - 6);

    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = "center";
    ctx.fillText(text, tx + tw / 2, ty + 14);
  }
}

function attachProfileHover() {
  const canvas = document.getElementById("sd-chart-profile");
  if (!canvas || canvas._profileHoverAttached) return;
  canvas._profileHoverAttached = true;
  canvas.style.cursor = "default";

  canvas.addEventListener("mousemove", e => {
    const rect  = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width / (window.devicePixelRatio || 1);
    const mx    = (e.clientX - rect.left) * scaleX;
    const edges = canvas._profileEdges;
    if (!edges) return;
    let found = null;
    for (let i = 0; i < edges.length; i++) {
      if (mx >= edges[i].x0 && mx < edges[i].x1) { found = i; break; }
    }
    if (found !== canvas._profileHoverIdx) {
      canvas._profileHoverIdx = found;
      canvas.style.cursor = found != null ? "pointer" : "default";
      drawPowerProfile(_sdSamples, found);
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (canvas._profileHoverIdx != null) {
      canvas._profileHoverIdx = null;
      canvas.style.cursor = "default";
      drawPowerProfile(_sdSamples, null);
    }
  });
}

function attachHoverListeners() {
  ["sd-chart-power", "sd-chart-pace", "sd-chart-spm", "sd-chart-hr", "sd-chart-force"].forEach(id => {
    const canvas = document.getElementById(id);
    if (!canvas || canvas._hoverAttached) return;
    canvas._hoverAttached = true;
    canvas.addEventListener("mousemove", e => {
      const meta = _sdChartMeta[id];
      if (!meta) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const t = (mouseX - meta.padL) / meta.W * meta.maxT;
      _sdHoverT = Math.max(0, Math.min(meta.maxT, t));
      redrawSessionCharts(_sdHoverT);
    });
    canvas.addEventListener("mouseleave", () => {
      _sdHoverT = null;
      redrawSessionCharts(null);
    });
  });
}

function drawSessionChart(canvasId, samples, field, colorVar, yLabel, yFmt, invertY, hoverT = null) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
  if (!cssW || !cssH) return;
  canvas.width  = cssW * dpr;  canvas.style.width  = cssW + "px";
  canvas.height = cssH * dpr;  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const pts = samples.filter(s =>
    s[field] != null && s[field] > 0 && (field !== "pace" || s[field] < 600)
  ).map(s => ({ t: s.t_sec, v: s[field] }));

  if (!pts.length) {
    ctx.fillStyle = "#9ba2af"; ctx.font = "13px system-ui";
    ctx.fillText("Keine Daten", 14, 20);
    return;
  }

  // rolling average ±5 points to smooth noise
  const sm = pts.map((p, i) => {
    const lo = Math.max(0, i - 5), hi = Math.min(pts.length - 1, i + 5);
    let sum = 0, n = 0;
    for (let j = lo; j <= hi; j++) { sum += pts[j].v; n++; }
    return { t: p.t, v: sum / n };
  });

  const padL = 40, padR = 10, padT = 22, padB = 26;
  const W = cssW - padL - padR, H = cssH - padT - padB;
  const maxT = pts[pts.length - 1].t;
  let minV = Math.min(...sm.map(p => p.v));
  let maxV = Math.max(...sm.map(p => p.v));
  const range = maxV - minV || 1;
  minV = Math.max(0, minV - range * 0.08);
  maxV += range * 0.08;

  const xOf = t => padL + (t / maxT) * W;
  const yOf = invertY
    ? v => padT + ((v - minV) / (maxV - minV)) * H
    : v => padT + H - ((v - minV) / (maxV - minV)) * H;

  _sdChartMeta[canvasId] = { maxT, padL, padR, W, padT, H, pts, yOf, yFmt, yLabel, colorVar };

  // grid + axis labels
  ctx.font = "10px system-ui"; ctx.fillStyle = "#9ba2af";
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y    = padT + H * frac;
    const val  = invertY ? minV + frac * (maxV - minV) : maxV - frac * (maxV - minV);
    ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.fillText(yFmt ? yFmt(Math.round(val)) : Math.round(val), 0, y + 3);
  }
  const tStep = maxT > 3600 ? 600 : maxT > 1200 ? 300 : 60;
  for (let t = 0; t <= maxT; t += tStep) {
    const x = xOf(t);
    ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + H); ctx.stroke();
    ctx.fillStyle = "#9ba2af";
    ctx.fillText(fmtTime(t).replace(/^0:/, ""), x - 12, padT + H + 15);
  }
  // axes
  ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + H + 1);
  ctx.lineTo(padL + W, padT + H + 1); ctx.stroke();
  ctx.fillStyle = "#9ba2af";
  ctx.fillText(yLabel, padL + 4, padT - 6);

  // area fill with gradient
  const colorStr = hexColor(colorVar);
  const rgba = (a) => colorStr.replace("rgb(", "rgba(").replace(")", `, ${a})`);
  const grad = ctx.createLinearGradient(0, padT, 0, padT + H);
  grad.addColorStop(0, rgba(0.25));
  grad.addColorStop(1, rgba(0.02));
  ctx.beginPath();
  ctx.moveTo(xOf(sm[0].t), padT + H);
  for (const p of sm) ctx.lineTo(xOf(p.t), yOf(p.v));
  ctx.lineTo(xOf(sm[sm.length - 1].t), padT + H);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath();
  ctx.moveTo(xOf(sm[0].t), yOf(sm[0].v));
  for (const p of sm) ctx.lineTo(xOf(p.t), yOf(p.v));
  ctx.strokeStyle = colorStr; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();

  // trendline (linear regression on raw pts)
  {
    const n = pts.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of pts) { sumX += p.t; sumY += p.v; sumXY += p.t * p.v; sumXX += p.t * p.t; }
    const denom = n * sumXX - sumX * sumX;
    if (denom !== 0) {
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      const t0 = pts[0].t, t1 = pts[n - 1].t;
      ctx.beginPath();
      ctx.moveTo(xOf(t0), yOf(slope * t0 + intercept));
      ctx.lineTo(xOf(t1), yOf(slope * t1 + intercept));
      ctx.strokeStyle = colorStr; ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]); ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  // crosshair
  if (hoverT != null && hoverT >= 0 && hoverT <= maxT) {
    const x = xOf(hoverT);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(55,65,81,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + H); ctx.stroke();
    ctx.setLineDash([]);

    const near = pts.reduce((best, p) =>
      Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT) ? p : best
    );
    if (near) {
      const cy = yOf(near.v);
      ctx.beginPath();
      ctx.arc(x, cy, 4, 0, 2 * Math.PI);
      ctx.fillStyle = colorStr;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      const valStr = (yFmt ? yFmt(Math.round(near.v)) : Math.round(near.v)) + " " + yLabel;
      ctx.font = "bold 11px system-ui";
      const tw = ctx.measureText(valStr).width + 10;
      const tx = Math.min(x + 8, cssW - tw - padR);
      const ty = Math.max(padT + 14, Math.min(cy, padT + H - 4));
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.beginPath();
      ctx.roundRect(tx, ty - 13, tw, 17, 3);
      ctx.fill();
      ctx.fillStyle = hexColor(colorVar);
      ctx.fillText(valStr, tx + 5, ty);
    }
    ctx.restore();
  }
}

$("#btn-session-back").onclick = () => showView("history");

$("#btn-quit").onclick = async () => {
  if (!confirm("App wirklich beenden?")) return;
  await fetch("/api/shutdown", { method: "POST" }).catch(() => {});
  window.close();
};

$("#btn-session-delete").onclick = async () => {
  if (!_sdSessionId || !confirm("Training wirklich löschen?")) return;
  try {
    await apiDeleteSession(_sdSessionId);
    _sdSessionId = null;
    showView("history");
  } catch (e) {
    alert("Löschen fehlgeschlagen: " + e.message);
  }
};


// ---------- weekday & month heatmaps ----------
function _sideHeatmapColor(r) {
  if (r >= 0.75) return "#b91c1c";
  if (r >= 0.5)  return "#ef4444";
  if (r >= 0.25) return "#3b82f6";
  if (r >  0)    return "#93c5fd";
  return document.documentElement.dataset.theme === "dark" ? "#21262d" : "#d1d5db";
}

function renderSideHeatmap(daily, elementId, binFn, labels, title) {
  const totals = labels.map(() => ({ dur: 0, count: 0, dist: 0 }));
  for (const d of daily) {
    if (!d.sessions) continue;
    const idx = binFn(new Date(d.day + "T00:00:00"));
    totals[idx].dur   += d.duration_s;
    totals[idx].count += d.sessions;
    totals[idx].dist  += d.distance_m;
  }
  const maxDur = Math.max(...totals.map(t => t.dur), 1);
  const cs = 12, gap = 3, step = cs + gap, padL = 28, padT = 16;
  const rows = labels.map((lbl, i) => {
    const t = totals[i];
    const color = _sideHeatmapColor(t.dur / maxDur);
    const y = padT + i * step;
    const ttip = t.count > 0
      ? `<title>${escapeHtml(`${lbl}: ${t.count}× · ${fmtTime(t.dur)} · ${fmtDistance(t.dist)}`)}</title>`
      : "";
    return `<text x="0" y="${y + cs - 2}" fill="#6b7280" font-size="10">${lbl}</text>` +
           `<rect x="${padL}" y="${y}" width="${cs}" height="${cs}" fill="${color}" rx="2">${ttip}</rect>`;
  }).join("");
  const svgW = padL + cs, svgH = padT + labels.length * step;
  document.getElementById(elementId).innerHTML =
    `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">` +
    `<text x="0" y="11" fill="#374151" font-size="10" font-weight="600">${title}</text>` +
    rows + `</svg>`;
}

function renderWeekdayHeatmap(daily) {
  renderSideHeatmap(daily, "weekday-hm",
    d => (d.getDay() + 6) % 7,
    ["Mo","Di","Mi","Do","Fr","Sa","So"], "Tag");
}
function renderMonthHeatmap(daily) {
  renderSideHeatmap(daily, "month-hm",
    d => d.getMonth(),
    ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"], "Monat");
}

// ---------- multi-session trends ----------
async function apiTrends() {
  const r = await fetch("/api/stats/trends");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

let _trendHoverSessionId = null;
let _lastTrendsData = null;

function _rollingBand(vals, W) {
  const p25 = [], mean = [], p75 = [];
  for (let i = 0; i < vals.length; i++) {
    const win = vals.slice(Math.max(0, i - W + 1), i + 1).slice().sort((a, b) => a - b);
    const wn  = win.length;
    p25.push(win[Math.max(0, Math.floor(wn * 0.25))]);
    mean.push(win.reduce((s, v) => s + v, 0) / wn);
    p75.push(win[Math.min(wn - 1, Math.floor(wn * 0.75))]);
  }
  return { p25, mean, p75 };
}

function _updateTrendHover(sessionId) {
  if (sessionId === _trendHoverSessionId) return;
  _trendHoverSessionId = sessionId;
  for (const m of TREND_METRICS) {
    const id = `tc-${m.key}`;
    const c  = document.getElementById(id);
    if (!c?._trendPts) continue;
    const hi = sessionId == null
      ? null
      : c._trendPts.findIndex(p => p.id === sessionId);
    drawTrendChart(id, c._trendPts, c._trendPct, c._trendMeta, hi >= 0 ? hi : null);
  }
}

const TREND_METRICS = [
  {
    key: "avg_power",      pctKey: "power",    label: "Leistung",
    unit: "W",      color: "var(--blue)",
    yFmt:    v => Math.round(v),
    tooltip: v => Math.round(v) + " W",
  },
  {
    key: "avg_pace",       pctKey: "pace",     label: "Pace",
    unit: "/500m",  color: "var(--green)",
    yFmt:    v => fmtPace(Math.round(v)),
    tooltip: v => fmtPace(Math.round(v)) + " /500m",
    invertY: true,
  },
  {
    key: "avg_spm",        pctKey: "spm",      label: "Schlagzahl",
    unit: "spm",    color: "var(--orange)",
    yFmt:    v => v.toFixed(1),
    tooltip: v => v.toFixed(1) + " spm",
  },
  {
    key: "total_distance", pctKey: "distance", label: "Distanz",
    unit: "m",      color: "var(--accent)",
    yFmt:    v => v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v) + "m",
    tooltip: fmtDistance,
  },
  {
    key: "duration_s",     pctKey: "duration", label: "Dauer",
    unit: "",       color: "#8b5cf6",
    yFmt:    v => fmtTime(v).replace(/^0:/, ""),
    tooltip: fmtTime,
  },
  {
    key: "force",          pctKey: null,       label: "Kraft",
    unit: "N",      color: "#d946ef",
    compute: s => (s.avg_power > 0 && s.avg_spm > 0)
      ? Math.round(s.avg_power * 92.3 / s.avg_spm)
      : null,
    yFmt:    v => Math.round(v),
    tooltip: v => Math.round(v) + " N",
  },
];

function renderTrends(data) {
  _lastTrendsData = data;
  const card    = document.getElementById("trends-card");
  const ppCard  = document.getElementById("trends-profile-card");
  if (!data || !data.series || data.series.length < 3) {
    card.hidden = ppCard.hidden = true;
    return;
  }
  card.hidden = false;

  const n     = data.series.length;
  const first = new Date(data.series[0].started_at);
  const last  = new Date(data.series[n - 1].started_at);
  const fmt   = d => d.toLocaleDateString("de-DE", { month: "short", year: "numeric" });
  document.getElementById("trends-subtitle").textContent =
    `${n} Einheiten · ${fmt(first)} – ${fmt(last)}`;

  const grid = document.getElementById("trends-charts-grid");
  grid.innerHTML = "";

  const rawW    = +(document.getElementById("trend-window")?.value ?? 10);
  const trendWin = rawW > 0 ? rawW : Infinity;

  for (const m of TREND_METRICS) {
    const valueOf = s => m.compute ? m.compute(s) : +s[m.key];
    const pts = data.series
      .filter(s => { const v = valueOf(s); return v != null && v > 0; })
      .map(s => ({ d: new Date(s.started_at), v: valueOf(s), id: s.id }));
    if (pts.length < 2) continue;

    const pct = pts.length >= 3 ? _rollingBand(pts.map(p => p.v), trendWin) : null;
    const cell = document.createElement("div");
    cell.innerHTML =
      `<div class="trend-cell-label">${m.label}</div>` +
      `<div class="trend-chart-wrap"><canvas id="tc-${m.key}"></canvas></div>`;
    grid.appendChild(cell);

    requestAnimationFrame(() => {
      drawTrendChart(`tc-${m.key}`, pts, pct, m);
      _attachTrendHover(`tc-${m.key}`);
    });
  }

  if (data.power_profile && data.power_profile.length >= 3) {
    ppCard.hidden = false;
    const nn = data.power_profile[0]?.n;
    document.getElementById("trends-profile-n").textContent =
      nn ? `(${nn} Einheiten)` : "";
    requestAnimationFrame(() => {
      drawProfileBands("trends-profile-canvas", data.power_profile);
      _attachProfileBandsHover("trends-profile-canvas", data.power_profile);
    });
  } else {
    ppCard.hidden = true;
  }
}

function drawTrendChart(canvasId, pts, pct, meta, hoverIdx = null) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  canvas._trendPts  = pts;
  canvas._trendPct  = pct;
  canvas._trendMeta = meta;

  const wrap = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
  if (!cssW || !cssH) return;

  canvas.width  = cssW * dpr;  canvas.style.width  = cssW + "px";
  canvas.height = cssH * dpr;  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const n = pts.length;
  const padL = 46, padR = 10, padT = 14, padB = 22;
  const W = cssW - padL - padR, H = cssH - padT - padB;

  canvas._trendLayout = { padL, W, n };

  const xOf = i => padL + (n === 1 ? W / 2 : (i / (n - 1)) * W);

  // Y range: include p10/p90 reference lines
  let allV = pts.map(p => p.v);
  if (pct) allV = allV.concat(pct.p25, pct.p75);
  let minV = Math.min(...allV), maxV = Math.max(...allV);
  const rng = maxV - minV || Math.abs(minV) * 0.1 || 1;
  minV -= rng * 0.1;  maxV += rng * 0.1;
  if (minV < 0 && !meta.invertY) minV = 0;

  // For pace (invertY): smaller value = faster = top of chart
  const yOf = meta.invertY
    ? v => padT + ((v - minV) / (maxV - minV)) * H
    : v => padT + H - ((v - minV) / (maxV - minV)) * H;

  // Y-axis grid + labels
  ctx.font = "10px system-ui"; ctx.textAlign = "right"; ctx.fillStyle = "#9ba2af";
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y   = padT + H * frac;
    const val = meta.invertY
      ? minV + frac * (maxV - minV)
      : maxV - frac * (maxV - minV);
    ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.fillText(meta.yFmt(val), padL - 4, y + 3);
  }
  if (meta.unit) {
    ctx.textAlign = "left"; ctx.font = "9px system-ui"; ctx.fillStyle = "#b0b8c6";
    ctx.fillText(meta.unit, padL + 3, padT - 3);
  }

  // Axes
  ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + H + 1);
  ctx.lineTo(padL + W, padT + H + 1); ctx.stroke();

  // P10-P90 rolling band
  if (pct && pct.p25.length === n) {
    ctx.beginPath();
    pct.p75.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(pct.p25[i]));
    ctx.closePath();
    ctx.fillStyle = "rgba(79,160,255,0.10)"; ctx.fill();

    ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(79,160,255,0.5)"; ctx.lineWidth = 1;
    ctx.beginPath();
    pct.p25.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
    ctx.stroke();
    ctx.beginPath();
    pct.p75.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(107,114,128,0.60)"; ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    pct.mean.forEach((v, i) => i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Series connecting line
  const col = hexColor(meta.color);
  ctx.beginPath();
  pts.forEach((p, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(p.v)) : ctx.lineTo(xOf(i), yOf(p.v)); });
  ctx.strokeStyle = col.replace(")", ",0.5)").replace("rgb(", "rgba(");
  ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();

  // Vertical guideline on hover
  if (hoverIdx != null) {
    const x = xOf(hoverIdx);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(55,65,81,0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + H); ctx.stroke();
    ctx.restore();
  }

  // Dots
  const dotR = n > 30 ? 2 : 3;
  for (let i = 0; i < n; i++) {
    const x = xOf(i), y = yOf(pts[i].v);
    const isHov = hoverIdx === i;
    ctx.beginPath(); ctx.arc(x, y, isHov ? dotR + 2 : dotR, 0, 2 * Math.PI);
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = isHov ? 2 : 1.5; ctx.stroke();
  }

  // X-axis date labels (≤6 labels)
  ctx.textAlign = "center"; ctx.fillStyle = "#9ba2af"; ctx.font = "10px system-ui";
  const step = Math.max(1, Math.ceil((n - 1) / 5));
  const shown = new Set();
  for (let i = 0; i < n; i += step) { shown.add(i); }
  shown.add(n - 1);
  for (const i of shown) {
    ctx.fillText(
      pts[i].d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
      xOf(i), padT + H + 14
    );
  }

  // Hover tooltip
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < n) {
    const p   = pts[hoverIdx];
    const x   = xOf(hoverIdx), y = yOf(p.v);
    const dStr = p.d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
    const vStr = meta.tooltip(p.v);
    const text = `${dStr}  ·  ${vStr}`;
    ctx.font = "bold 11px system-ui";
    const tw = ctx.measureText(text).width + 12, th = 18;
    const tx = Math.max(padL + 2, Math.min(cssW - padR - tw, x - tw / 2));
    const ty = Math.max(padT + 2, y - th - 6);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = "left";
    ctx.fillText(text, tx + 6, ty + 13);
  }
}

document.getElementById("trend-window").addEventListener("change", () => {
  if (_lastTrendsData) renderTrends(_lastTrendsData);
});

function _attachTrendHover(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || canvas._trendHoverOn) return;
  canvas._trendHoverOn = true;

  canvas.addEventListener("mousemove", e => {
    const ly = canvas._trendLayout;
    if (!ly || ly.n < 2) return;
    const mx   = e.clientX - canvas.getBoundingClientRect().left;
    const frac = Math.max(0, Math.min(1, (mx - ly.padL) / ly.W));
    const idx  = Math.round(frac * (ly.n - 1));
    _updateTrendHover(canvas._trendPts?.[idx]?.id ?? null);
  });

  canvas.addEventListener("mouseleave", () => _updateTrendHover(null));
}

function drawProfileBands(canvasId, bins, hoverIdx = null) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const dpr  = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth, cssH = wrap.clientHeight;
  if (!cssW || !cssH) return;

  canvas._ppBandsData = bins;

  canvas.width  = cssW * dpr;  canvas.style.width  = cssW + "px";
  canvas.height = cssH * dpr;  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 44, padR = 40, padT = 18, padB = 28;
  const W = cssW - padL - padR, H = cssH - padT - padB;

  const logMin = 0;
  const logMax = Math.log(bins[bins.length - 1].d);
  const xOf  = d => padL + (Math.log(d) - logMin) / (logMax - logMin) * W;
  const xTickLabel = t => t < 60 ? t + " s" : t < 3600 ? (t / 60) + " min" : (t / 3600) + " h";

  const allV = bins.flatMap(b => [b.p25, b.mean, b.p75]);
  const maxW = Math.max(...allV);
  const minW = Math.max(0, Math.min(...allV) * 0.88);
  const yOf  = v => padT + H - ((v - minW) / (maxW - minW || 1)) * H;

  // Y-axis grid
  ctx.font = "10px system-ui"; ctx.fillStyle = "#9ba2af";
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4, y = padT + H * frac;
    const val  = maxW - frac * (maxW - minW);
    ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText(Math.round(val), padL - 4, y + 3);
  }
  ctx.textAlign = "left"; ctx.fillText("W", padL + 4, padT - 5);

  // X ticks
  const xTicks = [1, 5, 10, 30, 60, 300, 600, 1800, 3600]
    .filter(t => t >= 1 && t <= bins[bins.length - 1].d);
  for (const t of xTicks) {
    const x = xOf(t);
    ctx.strokeStyle = "#eef0f4"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + H); ctx.stroke();
    ctx.fillStyle = "#9ba2af"; ctx.textAlign = "center"; ctx.font = "10px system-ui";
    ctx.fillText(xTickLabel(t), x, padT + H + 14);
  }

  // Axes
  ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + H + 1);
  ctx.lineTo(padL + W, padT + H + 1); ctx.stroke();

  // P10-P90 filled band
  ctx.beginPath();
  bins.forEach((b, i) => { i === 0 ? ctx.moveTo(xOf(b.d), yOf(b.p75)) : ctx.lineTo(xOf(b.d), yOf(b.p75)); });
  for (let i = bins.length - 1; i >= 0; i--) ctx.lineTo(xOf(bins[i].d), yOf(bins[i].p25));
  ctx.closePath();
  ctx.fillStyle = "rgba(79,160,255,0.13)"; ctx.fill();

  // P25 dashed boundary
  ctx.beginPath();
  bins.forEach((b, i) => { i === 0 ? ctx.moveTo(xOf(b.d), yOf(b.p25)) : ctx.lineTo(xOf(b.d), yOf(b.p25)); });
  ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(79,160,255,0.55)"; ctx.lineWidth = 1.5; ctx.stroke();

  // P75 dashed boundary
  ctx.beginPath();
  bins.forEach((b, i) => { i === 0 ? ctx.moveTo(xOf(b.d), yOf(b.p75)) : ctx.lineTo(xOf(b.d), yOf(b.p75)); });
  ctx.stroke(); ctx.setLineDash([]);

  // Mean line
  const blueStr = hexColor("var(--blue)");
  ctx.beginPath();
  bins.forEach((b, i) => { i === 0 ? ctx.moveTo(xOf(b.d), yOf(b.mean)) : ctx.lineTo(xOf(b.d), yOf(b.mean)); });
  ctx.strokeStyle = blueStr; ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.stroke();

  // Mean dots
  bins.forEach((b, i) => {
    const x = xOf(b.d), y = yOf(b.mean), isHov = hoverIdx === i;
    ctx.beginPath(); ctx.arc(x, y, isHov ? 6 : 4, 0, 2 * Math.PI);
    ctx.fillStyle = blueStr; ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = isHov ? 2 : 1.5; ctx.stroke();
  });

  // Right-edge labels P10 / ⌀ / P90
  if (bins.length) {
    const last = bins[bins.length - 1];
    const rx = xOf(last.d) + 6;
    ctx.font = "9px system-ui"; ctx.textAlign = "left"; ctx.fillStyle = "#9ba2af";
    ctx.fillText("P75", rx, yOf(last.p75) + 3);
    ctx.fillText("⌀",   rx, yOf(last.mean) + 3);
    ctx.fillText("P25", rx, yOf(last.p25) + 3);
  }

  // Hover tooltip
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < bins.length) {
    const b  = bins[hoverIdx];
    const cx = xOf(b.d), cy = yOf(b.mean);
    const label = xTickLabel(b.d);
    const text  = `${label}  ·  P25: ${Math.round(b.p25)} W  ⌀: ${Math.round(b.mean)} W  P75: ${Math.round(b.p75)} W`;
    ctx.font = "bold 11px system-ui";
    const tw = ctx.measureText(text).width + 14, th = 18;
    const tx = Math.max(padL, Math.min(cssW - padR - tw, cx - tw / 2));
    const ty = Math.max(padT + 2, cy - th - 8);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.strokeStyle = "#dbe0e6"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(tx, ty, tw, th, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = blueStr; ctx.textAlign = "left";
    ctx.fillText(text, tx + 7, ty + 13);
  }
}

function _attachProfileBandsHover(canvasId, bins) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || canvas._ppBandsHoverOn) return;
  canvas._ppBandsHoverOn = true;

  canvas.addEventListener("mousemove", e => {
    const rect  = canvas.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const cssW  = rect.width;
    const padL  = 44, padR = 40;
    const W     = cssW - padL - padR;
    const logMax = Math.log(bins[bins.length - 1].d);
    // find nearest bin
    let best = null, bestDx = Infinity;
    bins.forEach((b, i) => {
      const x = padL + (Math.log(b.d) - 0) / logMax * W;
      const dx = Math.abs(mx - x);
      if (dx < bestDx) { bestDx = dx; best = i; }
    });
    if (best !== canvas._ppBandsHI) {
      canvas._ppBandsHI = best;
      drawProfileBands(canvasId, bins, best);
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (canvas._ppBandsHI != null) {
      canvas._ppBandsHI = null;
      drawProfileBands(canvasId, bins, null);
    }
  });
}

window.addEventListener("resize", () => {
  drawChart(elapsedSec());
  if (!document.getElementById("view-session").hidden) redrawSessionCharts();
  if (!document.getElementById("view-history").hidden) {
    for (const m of TREND_METRICS) {
      const id = `tc-${m.key}`;
      const c  = document.getElementById(id);
      if (c?._trendPts) drawTrendChart(id, c._trendPts, c._trendPct, c._trendMeta, null);
    }
    const pp = document.getElementById("trends-profile-canvas");
    if (pp?._ppBandsData) drawProfileBands("trends-profile-canvas", pp._ppBandsData, null);
  }
});

// ---------- Kinomap import ----------
async function apiImportSession(file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/sessions/import", { method: "POST", body: fd });
  if (!r.ok) {
    let msg = `Upload fehlgeschlagen (${r.status})`;
    try { msg = (await r.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return await r.json();
}

(function wireKinomapImport() {
  const btn   = $("#btn-kinomap-import");
  const input = $("#kinomap-upload-input");
  const stat  = $("#import-status");
  if (!btn || !input) return;

  btn.onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    btn.disabled = true;
    stat.className = "import-status";
    stat.textContent = `Importiere ${f.name} …`;
    try {
      const res = await apiImportSession(f);
      const km  = res.total_distance != null
        ? (res.total_distance / 1000).toFixed(2).replace(".", ",") + " km"
        : "–";
      stat.className = "import-status ok";
      stat.textContent =
        `✓ "${res.workout_name}" importiert · ` +
        `${Math.round(res.duration_s / 60)} min · ${km} · ` +
        `${res.n_samples} Samples`;
      renderHistory();
    } catch (err) {
      stat.className = "import-status err";
      stat.textContent = "✗ " + err.message;
    } finally {
      btn.disabled = false;
      input.value = "";
    }
  };
})();

// ---------- energy calculation ----------
const SESSION_META_KEY = "wr_session_meta";

function loadSessionMeta() {
  try { return JSON.parse(localStorage.getItem(SESSION_META_KEY)) || {}; } catch { return {}; }
}
function saveSessionMeta(m) { localStorage.setItem(SESSION_META_KEY, JSON.stringify(m)); }

function calcSessionEnergy(durationSec, avgPower, profile) {
  if (!profile?.weight || !durationSec) return null;

  const dob    = profile.dob ? new Date(profile.dob) : null;
  const age    = dob ? Math.floor((Date.now() - dob) / (365.25 * 864e5)) : 35;
  const w      = profile.weight;
  const h      = profile.height || 170;

  const WIRKUNGSGRAD = profile.efficiency ? profile.efficiency / 100 : 0.22;

  // Mifflin-St Jeor BMR (kcal/day)
  const bmrDay = profile.gender === "female"
    ? 10 * w + 6.25 * h - 5 * age - 161
    : 10 * w + 6.25 * h - 5 * age + 5;
  const bmrSession = Math.round(bmrDay / 86400 * durationSec);

  let exerciseKcal;
  if (avgPower > 0) {
    // Arbeit [J] = Leistung [W] × Zeit [s]
    const arbeit_J  = avgPower * durationSec;
    // Mechanische Energie [kcal] = Arbeit [kJ] / 4,184
    const mech_kcal = arbeit_J / 1000 / 4.184;
    // Trainingsverbrauch (netto, über Ruhe) = mech. Energie / Wirkungsgrad
    exerciseKcal = Math.round(mech_kcal / WIRKUNGSGRAD);
  } else {
    // MET-Fallback ohne Leistungsdaten (MET 7 − MET 1 Ruhe = netto 6)
    exerciseKcal = Math.round(6 * w * durationSec / 3600);
  }

  // Gesamt = Trainingsverbrauch (netto) + Grundverbrauch (läuft parallel)
  const totalKcal = exerciseKcal + bmrSession;
  return { bmr_kcal: bmrSession, exercise_kcal: exerciseKcal, total_kcal: totalKcal };
}

function recordSessionEnergy(sessionId, userId) {
  if (!sessionId) return;
  const profile = userId
    ? (loadUsers().find(u => u.id === userId) || null)
    : getProfile();
  const avgPower  = dash.sums.n > 0 ? dash.sums.watt / dash.sums.n : 0;
  const energy    = calcSessionEnergy(Math.round(elapsedSec()), avgPower, profile);
  // Cache in localStorage for immediate display
  const meta      = loadSessionMeta();
  meta[sessionId] = { user_id: userId || null, ...(energy || {}) };
  saveSessionMeta(meta);
  // Persist in DB (fire-and-forget)
  if (energy) {
    apiPatchSessionEnergy(sessionId, { user_id: userId || null, ...energy }).catch(() => {});
  }
}

async function recalcAllEnergy(targetUserId) {
  const users   = loadUsers();
  const profile = targetUserId
    ? users.find(u => u.id === targetUserId)
    : users[0] || null;
  if (!profile) return 0;

  const sessions = await apiListSessions(10000);
  const meta     = loadSessionMeta();

  const updates = [];
  for (const s of sessions) {
    if (!s.duration_s) continue;
    const energy = calcSessionEnergy(s.duration_s, s.avg_power || 0, profile);
    if (!energy) continue;
    meta[s.id] = { ...meta[s.id], user_id: profile.id, ...energy };
    updates.push({ id: s.id, payload: { user_id: profile.id, ...energy } });
  }

  const BATCH = 20;
  for (let i = 0; i < updates.length; i += BATCH) {
    await Promise.all(updates.slice(i, i + BATCH).map(u =>
      apiPatchSessionEnergy(u.id, u.payload)
    ));
  }

  saveSessionMeta(meta);
  return updates.length;
}

// ---------- BLE admin API ----------
async function apiBleConfigGet() {
  const r = await fetch("/api/ble/config");
  return await r.json();
}
async function apiBleConfigSet(address) {
  await fetch("/api/ble/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
}
async function apiBleScan() {
  const r = await fetch("/api/ble/scan", { method: "POST" });
  if (!r.ok) { let m = `Scan fehlgeschlagen (${r.status})`; try { m = (await r.json()).detail || m; } catch {} throw new Error(m); }
  return await r.json();
}

async function renderBleConfig() {
  const btnSave = $("#btn-ble-save");
  const btnScan = $("#btn-ble-scan");
  const result  = $("#ble-scan-result");

  // Wire save button (idempotent — overwriting onclick is fine).
  btnSave.onclick = async () => {
    const addr = $("#ble-address-input").value.trim();
    if (!addr) { alert("Bitte eine Bluetooth-Adresse eingeben."); return; }
    await apiBleConfigSet(addr);
    await renderBleConfig();
  };

  // Wire scan button.
  btnScan.onclick = async () => {
    btnScan.disabled = true;
    result.innerHTML = "";

    const log = (html) => { result.innerHTML += html; };
    const br  = `<br>`;

    log(`<span style="color:var(--muted)">🔍 Scan gestartet…</span>`);

    let devices;
    try {
      devices = await apiBleScan();
    } catch (e) {
      log(`${br}<span style="color:var(--red)">✗ Fehler: ${escapeHtml(e.message)}</span>`);
      btnScan.disabled = false;
      return;
    }

    log(`${br}<span style="color:var(--muted)">Scan beendet.</span>`);

    if (!devices.length) {
      log(`${br}<span style="color:var(--muted)">Kein FTMS-Gerät gefunden.</span>`);
    } else {
      log(`${br}<span style="color:var(--green)">✓ ${devices.length === 1 ? "Gerät gefunden" : devices.length + " Geräte gefunden"}:</span>`);
      const picker = document.createElement("div");
      picker.innerHTML = devices.map(d =>
        `<div style="margin-top:6px">
          <button class="ghost btn-ble-pick" data-addr="${escapeHtml(d.address)}">
            ${escapeHtml(d.name || "Unbekannt")} · ${escapeHtml(d.address)}
          </button>
        </div>`
      ).join("");
      picker.querySelectorAll(".btn-ble-pick").forEach(b =>
        b.onclick = async () => {
          const addr = b.dataset.addr;
          $("#ble-address-input").value = addr;
          await apiBleConfigSet(addr);
          await renderBleConfig();
          result.innerHTML = `<span style="color:var(--green)">✓ Adresse ${escapeHtml(addr)} gespeichert.</span>`;
        }
      );
      result.appendChild(picker);
    }

    btnScan.disabled = false;
  };

  // Load current config from server.
  try {
    const cfg = await apiBleConfigGet();
    const addr = cfg.address;
    $("#ble-current-address").textContent = addr
      ? `Gespeicherte Adresse: ${addr}${cfg.connected ? "  ✓ verbunden" : ""}`
      : "Noch kein Gerät konfiguriert.";
    if (addr) $("#ble-address-input").value = addr;
    if (cfg.sim) {
      $("#ble-current-address").textContent = "Simulation-Modus aktiv – kein echtes Gerät.";
    }
  } catch (e) {
    $("#ble-current-address").textContent = "Konnte Konfiguration nicht laden.";
  }
}

// ---------- admin / user management ----------
const USERS_KEY       = "wr_users";
const ACTIVE_USER_KEY = "wr_active_user";

function loadUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch { return []; }
}
function saveUsers(u) { localStorage.setItem(USERS_KEY, JSON.stringify(u)); }
function getActiveUserId() { return localStorage.getItem(ACTIVE_USER_KEY) || null; }
function setActiveUserId(id) { localStorage.setItem(ACTIVE_USER_KEY, id); }
function getProfile() {
  const users = loadUsers(), id = getActiveUserId();
  return users.find(u => u.id === id) || users[0] || null;
}
function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function renderAdmin() {
  const users   = loadUsers();
  const activeId = getActiveUserId();
  const el = $("#admin-users");
  $("#admin-user-form").hidden = true;
  renderBleConfig();
  renderExportSessions();

  if (!users.length) {
    el.innerHTML = `<div class="empty-hint">Noch keine Benutzer. Klick auf <b>+ Neuer Benutzer</b>.</div>`;
    return;
  }

  el.innerHTML = users.map(u => {
    const isActive = u.id === activeId || (!activeId && users[0].id === u.id);
    const age = u.dob
      ? Math.floor((Date.now() - new Date(u.dob)) / (365.25 * 864e5))
      : null;
    const meta = [
      age !== null        ? `${age} J.`    : null,
      u.weight            ? `${u.weight} kg` : null,
      u.height            ? `${u.height} cm` : null,
      u.gender === "male"   ? "männl."
        : u.gender === "female" ? "weibl."
        : u.gender === "other"  ? "divers" : null,
      u.efficiency        ? `η ${u.efficiency} %` : null,
    ].filter(Boolean).join(" · ");
    const avatar = u.gender === "female" ? "👩" : "👤";
    return `<div class="user-card${isActive ? " active-user" : ""}">
      <div class="user-avatar">${avatar}</div>
      <div>
        <div style="font-weight:600">${escapeHtml(u.name || "–")}</div>
        <div style="font-size:13px;color:var(--muted)">${escapeHtml(meta) || "Keine Angaben"}</div>
      </div>
      <div class="user-card-actions">
        ${isActive
          ? `<span class="user-active-badge">● Aktiv</span>`
          : `<button class="ghost btn-set-active" data-uid="${u.id}">Aktiv setzen</button>`}
        <button class="ghost btn-edit-user" data-uid="${u.id}">Bearbeiten</button>
      </div>
    </div>`;
  }).join("");

  el.querySelectorAll(".btn-set-active").forEach(b =>
    b.onclick = () => { setActiveUserId(b.dataset.uid); renderAdmin(); }
  );
  el.querySelectorAll(".btn-edit-user").forEach(b =>
    b.onclick = () => openUserForm(b.dataset.uid)
  );
}

function openUserForm(uid) {
  const user = uid ? loadUsers().find(u => u.id === uid) : null;
  $("#admin-form-title").textContent = user ? "Benutzer bearbeiten" : "Neuer Benutzer";
  $("#admin-uid").value        = user?.id         || "";
  $("#admin-name").value       = user?.name       || "";
  $("#admin-dob").value        = user?.dob        || "";
  $("#admin-weight").value     = user?.weight     || "";
  $("#admin-height").value     = user?.height     || "";
  $("#admin-gender").value     = user?.gender     || "";
  $("#admin-efficiency").value = user?.efficiency || "";
  $("#btn-admin-delete").hidden = !user;
  $("#admin-user-form").hidden  = false;
  $("#admin-name").focus();
}

$("#btn-admin-new").onclick    = () => openUserForm(null);
$("#btn-admin-cancel").onclick = () => { $("#admin-user-form").hidden = true; };

$("#btn-admin-save").onclick = () => {
  const name = $("#admin-name").value.trim();
  if (!name) { alert("Bitte einen Namen eingeben."); return; }
  const users = loadUsers();
  const uid   = $("#admin-uid").value;
  const data  = {
    name,
    dob:        $("#admin-dob").value        || null,
    weight:     +$("#admin-weight").value    || null,
    height:     +$("#admin-height").value    || null,
    gender:     $("#admin-gender").value     || null,
    efficiency: +$("#admin-efficiency").value || null,
  };
  if (uid) {
    const idx = users.findIndex(u => u.id === uid);
    if (idx >= 0) users[idx] = { ...users[idx], ...data };
  } else {
    const newUser = { id: genId(), ...data };
    users.push(newUser);
    if (users.length === 1) setActiveUserId(newUser.id);
  }
  saveUsers(users);
  renderAdmin();
};

$("#btn-admin-delete").onclick = () => {
  const uid = $("#admin-uid").value;
  if (!uid || !confirm("Benutzer wirklich löschen?")) return;
  let users = loadUsers().filter(u => u.id !== uid);
  saveUsers(users);
  if (getActiveUserId() === uid) setActiveUserId(users[0]?.id || null);
  renderAdmin();
};

// ---------- export ----------

async function renderExportSessions() {
  const container = $("#export-sessions-list");
  container.innerHTML = '<div style="padding:8px 12px;color:var(--muted)">Lade …</div>';
  let sessions;
  try {
    const r = await fetch("/api/sessions?limit=500");
    sessions = await r.json();
  } catch {
    container.innerHTML = '<div style="padding:8px 12px;color:var(--red)">Fehler beim Laden.</div>';
    return;
  }
  if (!sessions.length) {
    container.innerHTML = '<div style="padding:8px 12px;color:var(--muted)">Keine Sessions vorhanden.</div>';
    $("#export-sel-count").textContent = "";
    return;
  }
  container.innerHTML = sessions.map(s => {
    const date = s.started_at ? new Date(s.started_at).toLocaleDateString("de-DE") : "–";
    const dur  = s.duration_s  ? fmtTime(s.duration_s) : "–";
    const dist = s.total_distance ? `${s.total_distance} m` : "–";
    return `<label style="display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;border-bottom:1px solid var(--border)">
      <input type="checkbox" class="export-cb" data-id="${s.id}" checked />
      <span style="flex:1;min-width:0">
        <span style="font-weight:500">${escapeHtml(s.workout_name || "Freies Training")}</span>
        <span style="color:var(--muted);margin-left:6px">${date} · ${dur} · ${dist}</span>
      </span>
    </label>`;
  }).join("");
  container.querySelectorAll(".export-cb").forEach(cb =>
    cb.addEventListener("change", updateExportCount)
  );
  updateExportCount();
}

function updateExportCount() {
  const all      = document.querySelectorAll(".export-cb").length;
  const checked  = document.querySelectorAll(".export-cb:checked").length;
  const span     = $("#export-sel-count");
  span.textContent = checked === all ? `${all} ausgewählt (alle)` : `${checked} von ${all} ausgewählt`;
}

function exportSelectedIds() {
  return [...document.querySelectorAll(".export-cb:checked")].map(cb => cb.dataset.id).join(",");
}

function triggerExportDownload(format) {
  const ids = exportSelectedIds();
  if (!ids) { alert("Keine Sessions ausgewählt."); return; }
  const url = `/api/export/${format}?ids=${encodeURIComponent(ids)}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

$("#btn-export-all").onclick  = () => {
  document.querySelectorAll(".export-cb").forEach(cb => { cb.checked = true; });
  updateExportCount();
};
$("#btn-export-none").onclick = () => {
  document.querySelectorAll(".export-cb").forEach(cb => { cb.checked = false; });
  updateExportCount();
};
$("#btn-export-csv").onclick  = () => triggerExportDownload("csv");
$("#btn-export-json").onclick = () => triggerExportDownload("json");
$("#btn-export-tcx").onclick  = () => triggerExportDownload("tcx");
$("#btn-export-fit").onclick  = () => triggerExportDownload("fit");


// ---------- energy recalculation ----------
$("#btn-recalc-energy").onclick = async () => {
  const btn = $("#btn-recalc-energy");
  const stat = $("#recalc-status");
  btn.disabled = true;
  stat.textContent = "Berechne …";
  stat.style.color = "var(--muted)";
  try {
    const n = await recalcAllEnergy(getActiveUserId());
    stat.textContent = `✓ ${n} Sessions aktualisiert`;
    stat.style.color = "#1f7a3a";
  } catch (e) {
    stat.textContent = "✗ Fehler: " + e.message;
    stat.style.color = "var(--red)";
  } finally {
    btn.disabled = false;
  }
};


// ---------- buttons ----------
$("#btn-free").onclick = startFreeTraining;

window.addEventListener("beforeunload", () => {
  if (dash.sessionId != null) {
    navigator.sendBeacon?.(
      `/api/sessions/${dash.sessionId}/stop`,
      new Blob([JSON.stringify({ completed: false })],
               { type: "application/json" })
    );
  }
});

// ---------- dark mode ----------
(function () {
  const toggle = document.getElementById("dark-mode-toggle");
  function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? "dark" : "";
    if (toggle) toggle.checked = dark;
  }
  applyTheme(localStorage.getItem("darkMode") === "1");
  if (toggle) {
    toggle.addEventListener("change", () => {
      const dark = toggle.checked;
      localStorage.setItem("darkMode", dark ? "1" : "0");
      applyTheme(dark);
    });
  }
})();

// ---------- boot ----------
showView("list");
updateDashboard();
