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
}
function accLine(a) {
  return `<div class="avatar" style="background:${color(a.id)}">${esc(initials(a.name))}</div>
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

// ---------- start ----------
(async () => {
  const c = await loadConfig();
  await loadAccounts();
  if (!c.apiId || !c.hasHash) show("settings");
})();
