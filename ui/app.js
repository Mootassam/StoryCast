const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLORS = ["#2aabee", "#7c3aed", "#ef4444", "#f59e0b", "#10b981", "#ec4899", "#6366f1", "#14b8a6"];
const color = (id) => COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initials = (n) => String(n || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const fileUrl = (p) => "file:///" + encodeURI(p.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F");
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");
function say(el, text, kind) { el.textContent = text || ""; el.className = "small " + (kind === "ok" ? "msg-ok" : kind === "err" ? "msg-err" : ""); }

let accounts = [];
const selected = new Set();
const states = {}; // id -> {status,msg}
let media = null, meta = null, running = false, scheduleTimer = null;

// ---------- tabs ----------
function show(tab) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab));
}
$$(".tab").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
document.addEventListener("click", (e) => { const g = e.target.closest("[data-goto]"); if (g) show(g.dataset.goto); });

// ---------- settings ----------
async function loadConfig() {
  const c = await sc.getConfig();
  $("#apiId").value = c.apiId;
  $("#apiHash").placeholder = c.hasHash ? "Saved ✓ (type to replace)" : "32 characters";
  return c;
}
$("#openApi").onclick = () => sc.openApiSite();
$("#saveCfg").onclick = async () => {
  const r = await sc.setConfig({ apiId: $("#apiId").value, apiHash: $("#apiHash").value });
  if (r.ok) { $("#apiHash").value = ""; await loadConfig(); say($("#cfgMsg"), "Saved ✓ Now add your accounts.", "ok"); }
  else say($("#cfgMsg"), r.error, "err");
};

// ---------- accounts ----------
async function loadAccounts() {
  accounts = await sc.listAccounts();
  for (const id of [...selected]) if (!accounts.some((a) => a.id === id)) selected.delete(id);
  $("#accCount").textContent = accounts.length;
  renderPostAccounts();
  renderAccTable();
  fillStatsAccounts();
  loadPhotos(false);
}
const photos = {}; // account id -> data URL
let photoQueue = Promise.resolve();
function avatarHtml(a) {
  return photos[a.id]
    ? `<img class="avatar" src="${photos[a.id]}" alt="" />`
    : `<div class="avatar" style="background:${color(a.id)}">${esc(initials(a.name))}</div>`;
}
// load photos one by one (saved copy first, so it is instant after the first time)
function loadPhotos(fresh, ids) {
  for (const a of accounts.filter((x) => !ids || ids.includes(x.id))) {
    if (!fresh && a.id in photos) continue;
    photoQueue = photoQueue.then(async () => {
      const r = await sc.accountPhoto({ id: a.id, fresh });
      if (r.ok) {
        photos[a.id] = r.photo;
        $$(`[data-id="${CSS.escape(a.id)}"] .avatar, [data-acc="${CSS.escape(a.id)}"] .avatar`).forEach((el) => (el.outerHTML = avatarHtml(a)));
      }
    }).catch(() => {}); // one failed photo must not stop the others
  }
}
function accLine(a) {
  return `${avatarHtml(a)}
    <div class="who"><b>${esc(a.name)} ${a.premium ? '<span class="star">★ Premium</span>' : ""}</b>
    <span>${esc(a.phone)}${a.username ? " · @" + esc(a.username) : ""}${a.status === "loggedout" ? ' · <span class="msg-err">logged out</span>' : a.status === "limit" ? ' · <span style="color:var(--warn)">limit reached</span>' : ""}</span></div>`;
}
function renderPostAccounts() {
  $("#noAccounts").classList.toggle("hidden", accounts.length > 0);
  $("#postAccounts").innerHTML = accounts.map((a) => {
    const st = states[a.id];
    return `<div class="accrow ${selected.has(a.id) ? "on" : ""}" data-id="${esc(a.id)}">
      <input type="checkbox" ${selected.has(a.id) ? "checked" : ""} ${running ? "disabled" : ""} />
      ${accLine(a)}
      <div class="state ${st ? esc(st.status) : ""}">${st ? esc(st.msg) : ""}</div></div>`;
  }).join("");
  $$("#postAccounts .accrow").forEach((row) => (row.onclick = () => {
    if (running) return;
    const id = row.dataset.id;
    selected.has(id) ? selected.delete(id) : selected.add(id);
    renderPostAccounts();
  }));
  updatePostBtn();
}
function renderAccTable() {
  $("#accTable").innerHTML = accounts.length ? accounts.map((a) => `<div class="accrow" data-id="${esc(a.id)}">${accLine(a)}
    <div class="state" data-note></div>
    <button class="ghost" data-act="check">Check</button>
    <button class="ghost" data-act="remove">Remove</button></div>`).join("")
    : `<div class="empty">No accounts yet. Click <b>+ Add account</b>.</div>`;
  $$("#accTable [data-act]").forEach((b) => (b.onclick = async () => {
    const row = b.closest(".accrow"), id = row.dataset.id, note = row.querySelector("[data-note]");
    if (b.dataset.act === "check") {
      note.textContent = "Checking…"; note.className = "state";
      const r = await sc.checkAccount(id);
      await loadAccounts();
      if (r.ok) loadPhotos(true, [id]);
      const n = document.querySelector(`#accTable .accrow[data-id="${CSS.escape(id)}"] [data-note]`);
      if (n) { n.textContent = !r.ok ? r.error : r.canPost ? "Ready to post ✓" : r.note; n.className = "state " + (r.ok && r.canPost ? "done" : "error"); }
    } else {
      const a = accounts.find((x) => x.id === id);
      if (!confirmRemove(row, a)) return;
    }
  }));
}
// Inline confirm (no browser dialogs): first click asks, second click removes.
function confirmRemove(row, a) {
  const btn = row.querySelector('[data-act="remove"]');
  if (btn.dataset.armed) {
    sc.removeAccount({ id: a.id, logout: true }).then(loadAccounts);
    return true;
  }
  btn.dataset.armed = "1";
  btn.textContent = "Click again to remove";
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "Remove"; } }, 4000);
  return false;
}
$("#checkAll").onclick = async () => {
  for (const b of $$('#accTable [data-act="check"]')) { b.click(); await new Promise((r) => setTimeout(r, 1500)); }
};

// ---------- add account modal ----------
let loginPhone = "";
function openModal() {
  $("#modal").classList.remove("hidden");
  ["#stepCode", "#stepPw"].forEach((s) => $(s).classList.add("hidden"));
  $("#stepPhone").classList.remove("hidden");
  $("#phone").value = ""; $("#code").value = ""; $("#pw").value = "";
  say($("#modalMsg"), "");
  $("#phone").focus();
}
async function closeModal() {
  $("#modal").classList.add("hidden");
  if (loginPhone) await sc.cancelLogin(loginPhone);
  loginPhone = "";
}
$("#addAcc").onclick = async () => {
  const c = await sc.getConfig();
  if (!c.apiId || !c.hasHash) { show("settings"); say($("#cfgMsg"), "First add your API ID and hash (one time only).", "err"); return; }
  openModal();
};
$("#closeModal").onclick = closeModal;
async function busy(btn, fn) { btn.disabled = true; const t = btn.textContent; btn.textContent = "Please wait…"; try { await fn(); } finally { btn.disabled = false; btn.textContent = t; } }
$("#sendCode").onclick = () => busy($("#sendCode"), async () => {
  const r = await sc.sendCode($("#phone").value);
  if (!r.ok) return say($("#modalMsg"), r.error, "err");
  loginPhone = r.phone;
  $("#codeWhere").textContent = r.viaApp ? "Telegram sent the code inside the Telegram app (check your chats with “Telegram”)." : "Telegram sent the code by SMS.";
  $("#stepPhone").classList.add("hidden"); $("#stepCode").classList.remove("hidden");
  say($("#modalMsg"), ""); $("#code").focus();
});
async function loggedIn(acc) {
  loginPhone = "";
  $("#modal").classList.add("hidden");
  selected.add(acc.id);
  await loadAccounts();
  loadPhotos(true, [acc.id]);
}
$("#signIn").onclick = () => busy($("#signIn"), async () => {
  const r = await sc.signIn({ phone: loginPhone, code: $("#code").value });
  if (!r.ok) return say($("#modalMsg"), r.error, "err");
  if (r.needPassword) {
    $("#pwHint").textContent = r.hint ? `Hint: ${r.hint}` : "";
    $("#stepCode").classList.add("hidden"); $("#stepPw").classList.remove("hidden");
    say($("#modalMsg"), ""); $("#pw").focus(); return;
  }
  await loggedIn(r.account);
});
$("#sendPw").onclick = () => busy($("#sendPw"), async () => {
  const r = await sc.password({ phone: loginPhone, password: $("#pw").value });
  $("#pw").value = "";
  if (!r.ok) return say($("#modalMsg"), r.error, "err");
  await loggedIn(r.account);
});
[["#phone", "#sendCode"], ["#code", "#signIn"], ["#pw", "#sendPw"]].forEach(([i, b]) => $(i).addEventListener("keydown", (e) => { if (e.key === "Enter") $(b).click(); }));

// ---------- media ----------
async function setMedia(info) {
  if (!info) return;
  if (info.error) { say($("#mediaInfo"), info.error, "err"); return; }
  media = info; meta = null;
  const url = fileUrl(info.path);
  $("#dropEmpty").classList.add("hidden");
  const p = $("#preview"); p.classList.remove("hidden");
  p.innerHTML = info.kind === "video"
    ? `<video src="${url}" muted controls preload="metadata"></video>`
    : `<img src="${url}" alt="" />`;
  p.insertAdjacentHTML("beforeend", `<div style="text-align:left"><b>${esc(info.name)}</b><br><span class="muted small">${fmtSize(info.size)}</span><br><button class="link" id="changeMedia">Change</button></div>`);
  say($("#mediaInfo"), "");
  if (info.kind === "video") {
    const v = p.querySelector("video");
    v.onloadedmetadata = () => {
      meta = { duration: Math.round(v.duration * 100) / 100, w: v.videoWidth, h: v.videoHeight };
      const warns = [];
      if (v.duration > 60) warns.push("longer than 60s, Telegram may refuse it or cut it");
      if (v.videoWidth > v.videoHeight) warns.push("horizontal, Stories look best vertical (9:16)");
      say($("#mediaInfo"), `${Math.round(v.duration)}s · ${v.videoWidth}×${v.videoHeight}` + (warns.length ? " · ⚠ " + warns.join("; ") : ""), warns.length ? "err" : "");
    };
    v.onerror = () => say($("#mediaInfo"), "Can't preview this video here (it may still post fine if it's H.264 MP4).", "err");
  }
  updatePostBtn();
}
$("#drop").onclick = async (e) => {
  if (e.target.closest("video")) return;
  if (running) return;
  setMedia(await sc.pickMedia());
};
$("#drop").ondragover = (e) => { e.preventDefault(); $("#drop").classList.add("over"); };
$("#drop").ondragleave = () => $("#drop").classList.remove("over");
$("#drop").ondrop = async (e) => {
  e.preventDefault(); $("#drop").classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f && !running) setMedia(await sc.mediaInfo(sc.pathOf(f)));
};
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// ---------- post ----------
function updatePostBtn() {
  const n = [...selected].filter((id) => accounts.some((a) => a.id === id)).length;
  const btn = $("#postBtn");
  btn.textContent = scheduleTimer ? "Scheduled ✓ (click to cancel)" : running ? "Posting…" : $("#useSchedule").checked ? `Schedule for ${n} account${n === 1 ? "" : "s"}` : `Post to ${n} account${n === 1 ? "" : "s"}`;
  btn.disabled = running || (!scheduleTimer && (!n || !media));
}
$("#selAll").onclick = () => { if (!running) { accounts.forEach((a) => selected.add(a.id)); renderPostAccounts(); } };
$("#selNone").onclick = () => { if (!running) { selected.clear(); renderPostAccounts(); } };
$("#useSchedule").onchange = () => {
  const on = $("#useSchedule").checked;
  $("#scheduleAt").classList.toggle("hidden", !on); $("#scheduleNote").classList.toggle("hidden", !on);
  if (on && !$("#scheduleAt").value) {
    const d = new Date(Date.now() + 3600e3); d.setSeconds(0, 0);
    $("#scheduleAt").value = new Date(d - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  }
  updatePostBtn();
};

sc.onProgress((p) => {
  states[p.id] = p;
  const el = document.querySelector(`#postAccounts .accrow[data-id="${CSS.escape(p.id)}"] .state`);
  if (el) { el.textContent = p.msg; el.className = "state " + p.status; } else renderPostAccounts();
});

async function runPost() {
  scheduleTimer = null;
  const ids = accounts.filter((a) => selected.has(a.id)).map((a) => a.id);
  if (!ids.length || !media) return updatePostBtn();
  running = true;
  ids.forEach((id) => (states[id] = { status: "waiting", msg: "In queue" }));
  Object.keys(states).forEach((id) => { if (!ids.includes(id)) delete states[id]; });
  renderPostAccounts();
  $("#stopBtn").classList.remove("hidden");
  say($("#postMsg"), "Posting… keep the app open.");
  const r = await sc.post({
    media, meta, caption: $("#caption").value.trim(), privacy: $("#privacy").value,
    period: Number($("#period").value), delaySec: Number($("#delay").value), accountIds: ids,
  });
  running = false;
  $("#stopBtn").classList.add("hidden");
  renderPostAccounts();
  if (!r.ok) say($("#postMsg"), r.error, "err");
  else say($("#postMsg"), `Finished: ${r.done} posted${r.failed ? `, ${r.failed} failed (see the reason next to each account)` : " ✓"}`, r.failed ? "err" : "ok");
}

$("#postBtn").onclick = () => {
  if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; say($("#postMsg"), "Schedule cancelled."); return updatePostBtn(); }
  if ($("#useSchedule").checked) {
    const at = new Date($("#scheduleAt").value).getTime();
    if (!at || at < Date.now() + 5000) return say($("#postMsg"), "Pick a time in the future.", "err");
    if (at - Date.now() > 2 ** 31 - 1) return say($("#postMsg"), "Pick a time within the next 24 days.", "err");
    scheduleTimer = setTimeout(runPost, at - Date.now());
    say($("#postMsg"), `Will post at ${new Date(at).toLocaleString()}. Keep StoryCast open.`, "ok");
    return updatePostBtn();
  }
  runPost();
};
$("#stopBtn").onclick = async () => { await sc.cancelPost(); say($("#postMsg"), "Stopping after the current account…"); };

// ---------- my stories: views + reactions ----------
const when = (ts) => new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ago = (ts) => {
  const s = Math.floor(Date.now() / 1000) - ts;
  return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : when(ts);
};
let storiesCache = [];
const storyThumbs = {}; // "accountId:storyId" -> sharp thumbnail

// account picker = chips with profile photos (the hidden <select> keeps the value)
function fillStatsAccounts() {
  const sel = $("#statsAcc"), cur = sel.value;
  sel.innerHTML = accounts.length ? accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("") : `<option value="">No accounts</option>`;
  if (accounts.some((a) => a.id === cur)) sel.value = cur;
  renderStatsChips();
}
function renderStatsChips() {
  const cur = $("#statsAcc").value;
  $("#statsChips").innerHTML = accounts.map((a) => `<button class="chip ${a.id === cur ? "on" : ""}" data-acc="${esc(a.id)}">${avatarHtml(a)}<span>${esc(a.name)}</span></button>`).join("");
  $$("#statsChips .chip").forEach((b) => (b.onclick = () => {
    if ($("#statsAcc").value === b.dataset.acc) return;
    $("#statsAcc").value = b.dataset.acc;
    renderStatsChips();
    $("#statsAcc").onchange();
  }));
}

// viewer photos: downloaded a few at a time, kept for this session
const viewerPhotos = {};
let vPhotoQueue = [], vPhotoBusy = 0;
function viewerAvatar(v) {
  return viewerPhotos[v.id]
    ? `<img class="avatar" src="${viewerPhotos[v.id]}" alt="" />`
    : `<div class="avatar" style="background:${color(v.id)}">${esc(initials(v.name))}</div>`;
}
function queueViewerPhotos(accId, list) {
  for (const v of list) if (v.hasPhoto && !(v.id in viewerPhotos) && !vPhotoQueue.some((q) => q.v.id === v.id)) vPhotoQueue.push({ accId, v });
  pumpViewerPhotos();
}
function pumpViewerPhotos() {
  while (vPhotoBusy < 2 && vPhotoQueue.length) {
    const { accId, v } = vPhotoQueue.shift();
    vPhotoBusy++;
    sc.viewerPhoto({ id: accId, userId: v.id }).then((r) => {
      viewerPhotos[v.id] = r.ok ? r.photo : "";
      if (r.ok && r.photo) $$(`#vList [data-vid="${CSS.escape(v.id)}"] .avatar`).forEach((el) => (el.outerHTML = viewerAvatar(v)));
    }).catch(() => {}).finally(() => { vPhotoBusy--; pumpViewerPhotos(); });
  }
}
/* run fn over items, at most n at the same time */
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}
function countTo(el, to) {
  const t0 = performance.now(), dur = 650;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function storyCard(s) {
  return `<button class="story" data-sid="${s.id}">
      <div class="th" style="${s.thumb ? `background-image:url('${s.thumb}')` : ""}">${s.kind === "video" ? "▶" : ""}</div>
      <span class="del-btn" data-del="${s.id}" title="Delete this story">🗑</span>
      <div class="info">
        <span class="badge ${s.active ? "live" : "old"}">${s.active ? "● Live" : "Ended"}</span>
        <span class="muted small">${when(s.date)}</span>
        <div class="nums"><span title="Views">👁 ${s.views}</span><span title="Reactions">❤ ${s.reactionsCount}</span></div>
        <div class="rx">${s.reactions.slice(0, 5).map((x) => `${esc(x.emoji)} ${x.count}`).join(" · ")}</div>
        ${s.caption ? `<div class="cap">${esc(s.caption)}</div>` : ""}
      </div></button>`;
}
function storyMsg() {
  const n = storiesCache.length, live = storiesCache.filter((s) => s.active).length;
  if (!n) return say($("#statsMsg"), "No stories on this account yet.");
  say($("#statsMsg"), `${n} ${n === 1 ? "story" : "stories"} (${live} live now). Click one to see who viewed and reacted.`);
}

async function loadStories() {
  const id = $("#statsAcc").value;
  if (!id) { $("#storyList").innerHTML = ""; return say($("#statsMsg"), "Add an account first."); }
  say($("#statsMsg"), "");
  // placeholders in the shape of story cards while Telegram answers
  $("#storyList").innerHTML = Array.from({ length: 4 }, () => `<div class="story skeleton"><div class="th skel"></div></div>`).join("");
  const r = await sc.listStories(id);
  if ($("#statsAcc").value !== id) return;
  if (!r.ok) { $("#storyList").innerHTML = ""; return say($("#statsMsg"), r.error, "err"); }
  storiesCache = r.stories;
  $("#storyList").innerHTML = r.stories.map(storyCard).join("");
  storyMsg();
  $$("#storyList .story").forEach((b) => (b.onclick = (e) => {
    const d = e.target.closest("[data-del]");
    if (d) { e.stopPropagation(); return askDelete(Number(d.dataset.del)); }
    openViewers(Number(b.dataset.sid));
  }));
  // sharp thumbnails, 3 at a time (the blurry preview turns sharp)
  await pool(r.stories, 3, async (s) => {
    const t = await sc.storyThumb({ id, storyId: s.id }).catch(() => null);
    if ($("#statsAcc").value !== id) return;
    if (t?.ok && t.photo) storyThumbs[id + ":" + s.id] = t.photo;
    const el = document.querySelector(`#storyList .story[data-sid="${s.id}"] .th`);
    if (t?.ok && t.photo && el) { el.style.backgroundImage = `url('${t.photo}')`; el.classList.add("sharp"); }
  });
}
$("#statsAcc").onchange = () => { $("#statsTotals").classList.add("hidden"); loadStories(); };
$("#statsRefresh").onclick = loadStories;

// Totals for all accounts: everything loads in the background (3 accounts at a time),
// a clean placeholder shows meanwhile, then all the numbers appear together.
let totalsRun = 0;
$("#statsAll").onclick = async () => {
  const run = ++totalsRun;
  const box = $("#statsTotals"), btn = $("#statsAll");
  box.classList.remove("hidden");
  btn.disabled = true;
  const skelTot = `<div class="tot loading"><div class="skel big"></div><div class="skel line"></div></div>`;
  const skelAcc = `<div class="tot acc loading"><div class="skel av"></div><div><div class="skel big"></div><div class="skel line"></div></div></div>`;
  box.innerHTML = skelTot.repeat(3) + `<div class="tot-progress"><span id="totStep">Loading ${accounts.length} accounts…</span><div class="bar"><span id="totBar"></span></div></div>` + skelAcc.repeat(accounts.length);
  const results = new Array(accounts.length);
  let done = 0;
  await pool(accounts, 3, async (a, k) => {
    results[k] = await sc.listStories(a.id).catch((e) => ({ ok: false, error: String(e) }));
    done++;
    if (run !== totalsRun) return;
    const bar = $("#totBar"), step = $("#totStep");
    if (bar) bar.style.width = Math.round((done / accounts.length) * 100) + "%";
    if (step) step.textContent = `Loading accounts… ${done} of ${accounts.length}`;
  });
  if (run !== totalsRun) return;
  await new Promise((res) => setTimeout(res, 250)); // let the bar reach the end
  let views = 0, reacts = 0, live = 0;
  const rows = accounts.map((a, k) => {
    const r = results[k];
    if (!r || !r.ok) return `<div class="tot acc reveal" data-acc="${esc(a.id)}">${avatarHtml(a)}<div><b class="msg-err">Couldn't load</b><span>${esc(a.name)}: ${esc((r && r.error) || "error")}</span></div></div>`;
    const act = r.stories.filter((s) => s.active);
    const v = act.reduce((n, s) => n + s.views, 0), x = act.reduce((n, s) => n + s.reactionsCount, 0);
    views += v; reacts += x; live += act.length;
    return { a, v, x, n: act.length };
  });
  const accHtml = rows.map((r, i) => typeof r === "string" ? r
    : `<div class="tot acc reveal" style="animation-delay:${120 + i * 50}ms" data-acc="${esc(r.a.id)}" title="Open ${esc(r.a.name)}">${avatarHtml(r.a)}<div><b>👁 ${r.v.toLocaleString()} · ❤ ${r.x.toLocaleString()}</b><span>${esc(r.a.name)} · ${r.n} live</span></div></div>`).join("");
  box.innerHTML = `<div class="tot reveal"><b id="totV">0</b><span>👁 Total views (live stories)</span></div>`
    + `<div class="tot reveal" style="animation-delay:50ms"><b id="totR">0</b><span>❤ Total reactions</span></div>`
    + `<div class="tot reveal" style="animation-delay:100ms"><b id="totL">0</b><span>Live stories</span></div>` + accHtml;
  countTo($("#totV"), views); countTo($("#totR"), reacts); countTo($("#totL"), live);
  $$("#statsTotals .tot.acc").forEach((el) => (el.onclick = () => {
    $("#statsAcc").value = el.dataset.acc;
    renderStatsChips();
    loadStories();
  }));
  btn.disabled = false;
};

// ---------- delete a story (and, optionally, the same story on the other accounts) ----------
let delState = null;
/* the "same story" on another account = posted within 10 minutes, same caption, same kind (StoryCast posts them together) */
const sameStory = (a, b) => Math.abs(a.date - b.date) <= 600 && (a.caption || "") === (b.caption || "") && a.kind === b.kind;

function askDelete(storyId) {
  const accId = $("#statsAcc").value;
  const s = storiesCache.find((x) => x.id === storyId);
  if (!s) return;
  const acc = accounts.find((a) => a.id === accId) || { name: "" };
  const run = {};
  delState = { accId, story: s, others: [], run };
  const thumb = storyThumbs[accId + ":" + storyId] || s.thumb;
  $("#dThumb").style.backgroundImage = thumb ? `url('${thumb}')` : "";
  $("#dInfo").textContent = `${acc.name} · ${s.active ? "live now" : "ended"} · posted ${when(s.date)} · 👁 ${s.views}`;
  $("#dAllRow").classList.add("hidden");
  $("#dAll").checked = true;
  $("#dProgress").classList.add("hidden");
  $("#dProgress span").style.width = "0";
  say($("#dMsg"), "");
  $("#dGo").disabled = false; $("#dCancel").disabled = false;
  $("#dGo").textContent = "Delete";
  $("#dModal").classList.remove("hidden");
  // look for the same story on the other accounts
  const others = accounts.filter((a) => a.id !== accId);
  if (!others.length) { $("#dFinding").textContent = ""; return; }
  $("#dFinding").textContent = "Checking your other accounts for the same story…";
  const found = [];
  pool(others, 3, async (a) => {
    const r = await sc.listStories(a.id).catch(() => null);
    if (r && r.ok) for (const x of r.stories) if (sameStory(x, s)) found.push({ acc: a, story: x });
  }).then(() => {
    if (delState?.run !== run) return;
    found.sort((x, y) => accounts.indexOf(x.acc) - accounts.indexOf(y.acc));
    delState.others = found;
    $("#dFinding").textContent = found.length ? "" : "This story is only on this account.";
    if (found.length) {
      const names = [...new Set(found.map((f) => f.acc.name))];
      $("#dAllText").textContent = `Also delete it from my other ${names.length === 1 ? "account" : names.length + " accounts"} (${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""})`;
      $("#dAllRow").classList.remove("hidden");
    }
  });
}
function closeDelete() { if ($("#dGo").disabled && delState?.busy) return; delState = null; $("#dModal").classList.add("hidden"); }
$("#dCancel").onclick = closeDelete;
$("#dModal").addEventListener("click", (e) => { if (e.target.id === "dModal") closeDelete(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && delState && !$("#dModal").classList.contains("hidden")) closeDelete(); });

$("#dGo").onclick = async () => {
  const st = delState;
  if (!st) return;
  st.busy = true;
  $("#dGo").disabled = true; $("#dCancel").disabled = true;
  $("#dGo").textContent = "Deleting…";
  const jobs = [{ acc: accounts.find((a) => a.id === st.accId) || { id: st.accId, name: "" }, story: st.story }];
  if (!$("#dAllRow").classList.contains("hidden") && $("#dAll").checked) jobs.push(...st.others);
  // group by account: one request per account
  const byAcc = new Map();
  for (const j of jobs) { if (!byAcc.has(j.acc.id)) byAcc.set(j.acc.id, { acc: j.acc, ids: [] }); byAcc.get(j.acc.id).ids.push(j.story.id); }
  const groups = [...byAcc.values()];
  $("#dProgress").classList.remove("hidden");
  let done = 0; const errors = [], failed = new Set();
  for (const g of groups) {
    const r = await sc.deleteStories({ id: g.acc.id, storyIds: g.ids }).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { errors.push(`${g.acc.name}: ${r.error}`); failed.add(g.acc.id); }
    done++;
    $("#dProgress span").style.width = Math.round((done / groups.length) * 100) + "%";
  }
  st.busy = false;
  const mainOk = !failed.has(st.accId);
  // the open account: take the card away
  if (mainOk) {
    storiesCache = storiesCache.filter((x) => x.id !== st.story.id);
    const card = document.querySelector(`#storyList .story[data-sid="${st.story.id}"]`);
    if (card) { card.classList.add("removing"); setTimeout(() => { card.remove(); storyMsg(); }, 340); } else storyMsg();
    if (vState && vState.storyId === st.story.id) closeViewer();
    $("#statsTotals").classList.add("hidden"); // numbers changed: totals need a fresh load
  }
  if (errors.length) {
    $("#dGo").textContent = "Delete"; $("#dGo").disabled = false; $("#dCancel").disabled = false;
    return say($("#dMsg"), `Not deleted on ${errors.length === 1 ? "1 account" : errors.length + " accounts"}: ${errors.join(" · ")}`, "err");
  }
  say($("#dMsg"), groups.length > 1 ? `✓ Deleted from ${groups.length} accounts.` : "✓ Story deleted.", "ok");
  setTimeout(closeDelete, 900);
};
$("#svDelete").onclick = () => { if (vState) askDelete(vState.storyId); };

// viewers modal
let vState = null;
// count-up animation for the big numbers
function countUp(el, to) {
  const t0 = performance.now(), dur = 700;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))).toLocaleString();
    if (k < 1 && vState) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function setBar(p) { $("#svBar").style.width = Math.max(0, Math.min(100, p * 100)) + "%"; }

function openViewers(storyId) {
  const s = storiesCache.find((x) => x.id === storyId);
  const accId = $("#statsAcc").value;
  const acc = accounts.find((a) => a.id === accId) || { id: accId, name: "" };
  vState = { id: accId, storyId, next: "", list: [] };
  const st = vState;

  // left: story (sharp thumbnail first, then the real photo/video)
  const thumb = storyThumbs[accId + ":" + storyId] || s.thumb;
  $("#svMedia").innerHTML = thumb ? `<div class="bg" style="background-image:url('${thumb}')"></div><img class="fit" src="${thumb}" alt="" />` : "";
  $("#svAcc").innerHTML = `${avatarHtml(acc)}<div>${esc(acc.name)}<small>${ago(s.date)}</small></div>`;
  setBar(0);
  $("#svLoading").textContent = s.kind === "video" ? "Loading video…" : "Loading photo…";
  $("#svLoading").classList.remove("hidden");
  sc.storyFull({ id: accId, storyId }).then((r) => {
    if (st !== vState) return;
    $("#svLoading").classList.add("hidden");
    if (!r.ok) { $("#svLoading").textContent = r.error; $("#svLoading").classList.remove("hidden"); return; }
    const url = fileUrl(r.path);
    const bg = thumb ? `<div class="bg" style="background-image:url('${thumb}')"></div>` : "";
    if (r.kind === "video") {
      $("#svMedia").innerHTML = bg + `<video class="fit" src="${url}" autoplay loop playsinline controls></video>`;
      const v = $("#svMedia video");
      v.volume = 0.6;
      v.ontimeupdate = () => setBar(v.duration ? v.currentTime / v.duration : 0);
    } else {
      $("#svMedia").innerHTML = bg + `<img class="fit" src="${url}" alt="" />`;
      setBar(1);
    }
  });

  // right: caption + big numbers
  $("#svBadge").className = "badge " + (s.active ? "live" : "old");
  $("#svBadge").textContent = s.active ? "● Live" : "Ended";
  const left = s.expires - Math.floor(Date.now() / 1000);
  $("#svWhen").textContent = `Posted ${when(s.date)}` + (s.active ? ` · ends in ${left > 3600 ? Math.floor(left / 3600) + "h " : ""}${Math.floor((left % 3600) / 60)}m` : "");
  $("#svCaption").textContent = s.caption || "No caption";
  $("#svCaption").classList.toggle("empty", !s.caption);
  countUp($("#svViews"), s.views);
  countUp($("#svReacts"), s.reactionsCount);
  $("#svEmojis").innerHTML = s.reactions.length
    ? s.reactions.slice().sort((x, y) => y.count - x.count).map((x) => `<span><i>${esc(x.emoji)}</i>${x.count}</span>`).join("")
    : `<span class="muted" style="font-weight:600">No reactions yet</span>`;
  $("#svCount").textContent = "";
  $("#vSearch").value = "";
  $("#vModal").classList.remove("hidden");
  loadViewers(true);
}
sc.onFullProgress((p) => { if (vState && p.id === vState.id && p.storyId === vState.storyId) setBar(p.p); });
function closeViewer() {
  vState = null;
  $("#vModal").classList.add("hidden");
  $("#svMedia").innerHTML = ""; // stops the video
}
$("#vModal").addEventListener("click", (e) => { if (e.target.id === "vModal") closeViewer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && vState && $("#dModal").classList.contains("hidden")) closeViewer(); });
async function loadViewers(reset) {
  if (!vState) return;
  if (reset) { vState.next = ""; vState.list = []; $("#vList").innerHTML = ""; }
  const st = vState;
  say($("#vMsg"), "Loading viewers…");
  $("#vMore").classList.add("hidden");
  const r = await sc.viewers({ id: st.id, storyId: st.storyId, offset: st.next, reactionsFirst: $("#vReactFirst").checked, q: $("#vSearch").value.trim() });
  if (st !== vState) return;
  if (!r.ok) return say($("#vMsg"), r.error, "err");
  st.list.push(...r.viewers);
  st.next = r.next;
  vPhotoQueue = []; // forget photos waiting for an older list
  $("#vList").innerHTML = st.list.length ? st.list.map((v) => `<div class="vrow" data-vid="${esc(v.id)}">
      ${viewerAvatar(v)}
      <div class="who"><b>${esc(v.name)}</b><span>${v.username ? "@" + esc(v.username) + " · " : ""}${ago(v.date)}</span></div>
      <span class="r">${esc(v.reaction)}</span></div>`).join("")
    : `<div class="empty">${$("#vSearch").value ? "No viewer with that name." : "No viewers yet."}</div>`;
  $("#vMore").classList.toggle("hidden", !r.next);
  queueViewerPhotos(st.id, st.list);
  $("#svCount").textContent = `(${r.count})`;
  say($("#vMsg"), r.next ? `${st.list.length} of ${r.count} shown` : "");
}
$("#vMore").onclick = () => loadViewers(false);
$("#vClose").onclick = closeViewer;
$("#vReactFirst").onchange = () => loadViewers(true);
let vTimer;
$("#vSearch").oninput = () => { clearTimeout(vTimer); vTimer = setTimeout(() => loadViewers(true), 450); };

$$(".tab").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.tab === "stats") { fillStatsAccounts(); if (!$("#storyList").children.length) loadStories(); }
}));

// ---------- start ----------
(async () => {
  const c = await loadConfig();
  await loadAccounts();
  if (!c.apiId || !c.hasHash) show("settings");
})();
