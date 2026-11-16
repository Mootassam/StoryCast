// StoryCast — post one Telegram Story to many of YOUR accounts.
// Sessions are stored only on this computer, encrypted with Windows safeStorage.
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { TelegramClient, Api, helpers } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { CustomFile } = require("telegram/client/uploads");
const { computeCheck } = require("telegram/Password");

let win;
const dataDir = () => app.getPath("userData");
const file = (n) => path.join(dataDir(), n);

// ---------- storage ----------
const enc = (s) => (safeStorage.isEncryptionAvailable() ? "e:" + safeStorage.encryptString(s).toString("base64") : "p:" + s);
const dec = (s) => (!s ? "" : s.startsWith("e:") ? safeStorage.decryptString(Buffer.from(s.slice(2), "base64")) : s.slice(2));
function readJson(n, def) {
  try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch { return def; }
}
function writeJson(n, v) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file(n) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, file(n));
}
const getConfig = () => readJson("config.json", {});
const getAccounts = () => readJson("accounts.json", []);
const saveAccounts = (a) => writeJson("accounts.json", a);
const publicAcc = (a) => ({ id: a.id, phone: a.phone, name: a.name, username: a.username, premium: a.premium, status: a.status || "ok" });

function creds() {
  const c = getConfig();
  if (!c.apiId || !c.apiHash) throw new Error("Add your API ID and API hash in Settings first.");
  return { apiId: Number(c.apiId), apiHash: dec(c.apiHash) };
}

function makeClient(session = "") {
  const { apiId, apiHash } = creds();
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
    deviceModel: "StoryCast Desktop",
    appVersion: app.getVersion(),
    systemVersion: "Windows",
  });
  client.setLogLevel("error");
  return client;
}

// ---------- connected clients ----------
const clients = new Map(); // account id -> TelegramClient
async function clientFor(acc) {
  let c = clients.get(acc.id);
  if (!c) {
    c = makeClient(dec(acc.session));
    clients.set(acc.id, c);
  }
  if (!c.connected) await c.connect();
  return c;
}
async function dropClient(id) {
  const c = clients.get(id);
  clients.delete(id);
  if (c) try { await c.disconnect(); } catch {}
}

// ---------- friendly errors ----------
function explain(err) {
  const m = String(err?.errorMessage || err?.message || err);
  if (/FLOOD_WAIT_(\d+)|FLOOD/.test(m)) return `Telegram says slow down. Wait ${err.seconds || m.match(/\d+/)?.[0] || "a few"} seconds and try again.`;
  if (m.includes("PHONE_NUMBER_INVALID")) return "That phone number is not valid. Use the full number with country code, e.g. +62812…";
  if (m.includes("PHONE_CODE_INVALID")) return "Wrong code. Check the code Telegram sent and try again.";
  if (m.includes("PHONE_CODE_EXPIRED")) return "The code expired. Send a new code.";
  if (m.includes("PASSWORD_HASH_INVALID")) return "Wrong 2-step verification password.";
  if (m.includes("API_ID_INVALID")) return "The API ID / hash is wrong. Copy them again from my.telegram.org.";
  if (m.includes("AUTH_KEY_UNREGISTERED") || m.includes("SESSION_REVOKED") || m.includes("USER_DEACTIVATED")) return "This account was logged out. Remove it and add it again.";
  if (m.includes("STORIES_TOO_MUCH")) return "Daily Story limit reached for this account (free accounts can post only a few per day).";
  if (m.includes("PREMIUM_ACCOUNT_REQUIRED")) return "This needs Telegram Premium on this account.";
  if (m.includes("STORY_PERIOD_INVALID")) return "This Story duration needs Premium. Use 24 hours.";
  if (m.includes("MEDIA_") || m.includes("VIDEO_")) return `Telegram didn't accept this file (${m}). Use a vertical MP4 (H.264) up to 60 seconds, or a JPG/PNG photo.`;
  return m;
}
const ok = (data = {}) => ({ ok: true, ...data });
const fail = (e) => ({ ok: false, error: explain(e) });

// ---------- settings ----------
ipcMain.handle("config:get", () => {
  const c = getConfig();
  return { apiId: c.apiId || "", hasHash: !!c.apiHash };
});
ipcMain.handle("config:set", (_e, { apiId, apiHash }) => {
  if (!/^\d{3,12}$/.test(String(apiId || "").trim())) return fail("API ID must be a number.");
  const c = getConfig();
  c.apiId = String(apiId).trim();
  if (apiHash && apiHash.trim()) {
    if (!/^[a-f0-9]{32}$/i.test(apiHash.trim())) return fail("API hash should be 32 letters/numbers.");
    c.apiHash = enc(apiHash.trim());
  }
  if (!c.apiHash) return fail("API hash is required.");
  writeJson("config.json", c);
  return ok();
});
ipcMain.handle("open:apisite", () => shell.openExternal("https://my.telegram.org/apps"));

// ---------- add account (phone -> code -> optional 2FA password) ----------
const pending = new Map(); // phone -> { client, phoneCodeHash }
const normPhone = (p) => "+" + String(p || "").replace(/[^\d]/g, "");

async function finishLogin(phone, client) {
  const me = await client.getMe();
  const accounts = getAccounts();
  const id = String(me.id);
  const rec = {
    id,
    phone,
    name: [me.firstName, me.lastName].filter(Boolean).join(" ") || phone,
    username: me.username || "",
    premium: !!me.premium,
    session: enc(client.session.save()),
    status: "ok",
  };
  const i = accounts.findIndex((a) => a.id === id);
  if (i >= 0) accounts[i] = rec; else accounts.push(rec);
  saveAccounts(accounts);
  await dropClient(id);
  clients.set(id, client);
  pending.delete(phone);
  return publicAcc(rec);
}

ipcMain.handle("acc:sendCode", async (_e, rawPhone) => {
  const phone = normPhone(rawPhone);
  if (phone.length < 8) return fail("Enter the full phone number with country code.");
  try {
    const old = pending.get(phone);
    if (old) try { await old.client.disconnect(); } catch {}
    const client = makeClient();
    await client.connect();
    const r = await client.sendCode(creds(), phone);
    pending.set(phone, { client, phoneCodeHash: r.phoneCodeHash });
    return ok({ phone, viaApp: r.isCodeViaApp });
  } catch (e) { return fail(e); }
});

ipcMain.handle("acc:signIn", async (_e, { phone, code }) => {
  const p = pending.get(phone);
  if (!p) return fail("Send the code first.");
  try {
    const r = await p.client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: p.phoneCodeHash, phoneCode: String(code).trim() }));
    if (r instanceof Api.auth.AuthorizationSignUpRequired) return fail("This phone number has no Telegram account yet.");
    return ok({ account: await finishLogin(phone, p.client) });
  } catch (e) {
    if (String(e?.errorMessage || e).includes("SESSION_PASSWORD_NEEDED")) {
      try {
        const pw = await p.client.invoke(new Api.account.GetPassword());
        return ok({ needPassword: true, hint: pw.hint || "" });
      } catch (e2) { return fail(e2); }
    }
    return fail(e);
  }
});

ipcMain.handle("acc:password", async (_e, { phone, password }) => {
  const p = pending.get(phone);
  if (!p) return fail("Start again: send the code first.");
  try {
    const srp = await p.client.invoke(new Api.account.GetPassword());
    await p.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(srp, password) }));
    return ok({ account: await finishLogin(phone, p.client) });
  } catch (e) { return fail(e); }
});

ipcMain.handle("acc:cancel", async (_e, phone) => {
  const p = pending.get(phone);
  pending.delete(phone);
  if (p) try { await p.client.disconnect(); } catch {}
  return ok();
});

ipcMain.handle("acc:list", () => getAccounts().map(publicAcc));

ipcMain.handle("acc:remove", async (_e, { id, logout }) => {
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return ok();
  if (logout) {
    try { const c = await clientFor(acc); await c.invoke(new Api.auth.LogOut()); } catch {}
  }
  await dropClient(id);
  try { fs.unlinkSync(avatarFile(id)); } catch {}
  saveAccounts(accounts.filter((a) => a.id !== id));
  return ok();
});

// Checks the account still works + refreshes name/Premium + whether it can post a Story now.
ipcMain.handle("acc:check", async (_e, id) => {
  const accounts = getAccounts();
  const acc = accounts.find((a) => a.id === id);
  if (!acc) return fail("Account not found.");
  try {
    const c = await clientFor(acc);
    const me = await c.getMe();
    acc.name = [me.firstName, me.lastName].filter(Boolean).join(" ") || acc.phone;
    acc.username = me.username || "";
    acc.premium = !!me.premium;
    let canPost = true, note = "";
    try { await c.invoke(new Api.stories.CanSendStory({ peer: new Api.InputPeerSelf() })); }
    catch (e) { canPost = false; note = explain(e); }
    acc.status = canPost ? "ok" : "limit";
    saveAccounts(accounts);
    return ok({ account: publicAcc(acc), canPost, note });
  } catch (e) {
    const msg = explain(e);
    if (msg.includes("logged out")) { acc.status = "loggedout"; saveAccounts(accounts); }
    return fail(e);
  }
});

// ---------- pick media ----------
ipcMain.handle("media:pick", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Video or photo", extensions: ["mp4", "mov", "jpg", "jpeg", "png"] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return mediaInfo(r.filePaths[0]);
});
ipcMain.handle("media:info", (_e, p) => mediaInfo(p));
function mediaInfo(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const kind = ["mp4", "mov"].includes(ext) ? "video" : ["jpg", "jpeg", "png"].includes(ext) ? "photo" : null;
  if (!kind) return { error: "Use an MP4/MOV video or a JPG/PNG photo." };
  const size = fs.statSync(p).size;
  return { path: p, name: path.basename(p), size, kind, mime: ext === "mov" ? "video/quicktime" : ext === "mp4" ? "video/mp4" : ext === "png" ? "image/png" : "image/jpeg" };
}

// ---------- post ----------
let cancelRun = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (ch, v) => win && !win.isDestroyed() && win.webContents.send(ch, v);

function privacyRules(privacy) {
  if (privacy === "contacts") return [new Api.InputPrivacyValueAllowContacts()];
  if (privacy === "close") return [new Api.InputPrivacyValueAllowCloseFriends()];
  return [new Api.InputPrivacyValueAllowAll()];
}

async function postOne(acc, job) {
  const c = await clientFor(acc);
  // ask Telegram first so we don't waste upload time
  await c.invoke(new Api.stories.CanSendStory({ peer: new Api.InputPeerSelf() }));
  send("post:progress", { id: acc.id, status: "uploading", msg: "Uploading…" });
  const m = job.media;
  const uploaded = await c.uploadFile({
    file: new CustomFile(m.name, m.size, m.path),
    workers: 2,
    onProgress: (p) => send("post:progress", { id: acc.id, status: "uploading", msg: `Uploading ${Math.round(p * 100)}%` }),
  });
  const media = m.kind === "video"
    ? new Api.InputMediaUploadedDocument({
        file: uploaded,
        mimeType: m.mime,
        attributes: [
          new Api.DocumentAttributeVideo({ duration: job.meta?.duration || 1, w: job.meta?.w || 720, h: job.meta?.h || 1280, supportsStreaming: true }),
          new Api.DocumentAttributeFilename({ fileName: m.name }),
        ],
      })
    : new Api.InputMediaUploadedPhoto({ file: uploaded });

  // 6h / 12h / 48h are Premium-only: free accounts fall back to 24h
  let period = Number(job.period) || 86400;
  let note = "";
  if (period !== 86400 && !acc.premium) { period = 86400; note = " (24h: other durations need Premium)"; }

  send("post:progress", { id: acc.id, status: "sending", msg: "Publishing…" });
  await c.invoke(new Api.stories.SendStory({
    peer: new Api.InputPeerSelf(),
    media,
    caption: job.caption || undefined,
    privacyRules: privacyRules(job.privacy),
    randomId: helpers.generateRandomLong(),
    period,
  }));
  return note;
}

ipcMain.handle("post:start", async (_e, job) => {
  cancelRun = false;
  const all = getAccounts();
  const list = job.accountIds.map((id) => all.find((a) => a.id === id)).filter(Boolean);
  if (!list.length) return fail("Select at least one account.");
  if (!job.media?.path || !fs.existsSync(job.media.path)) return fail("Pick a video or photo first.");
  const delay = Math.max(5, Number(job.delaySec) || 20);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const acc = list[i];
    if (cancelRun) { send("post:progress", { id: acc.id, status: "skipped", msg: "Stopped" }); continue; }
    try {
      const note = await postOne(acc, job);
      send("post:progress", { id: acc.id, status: "done", msg: "Posted ✓" + note });
      results.push({ id: acc.id, ok: true });
    } catch (e) {
      send("post:progress", { id: acc.id, status: "error", msg: explain(e) });
      try { fs.appendFileSync(file("errors.log"), JSON.stringify({ at: new Date().toISOString(), account: acc.id, error: String(e?.errorMessage || e?.message || e), media: { name: job.media.name, size: job.media.size, kind: job.media.kind, mime: job.media.mime }, meta: job.meta }) + "\n"); } catch {}
      results.push({ id: acc.id, ok: false });
    }
    // wait between accounts (with a little randomness) so it doesn't look like spam
    if (i < list.length - 1 && !cancelRun) {
      const wait = delay * 1000 + Math.floor(Math.random() * delay * 500);
      const next = list[i + 1];
      for (let left = wait; left > 0 && !cancelRun; left -= 1000) {
        send("post:progress", { id: next.id, status: "waiting", msg: `Starts in ${Math.ceil(left / 1000)}s` });
        await sleep(Math.min(1000, left));
      }
    }
  }
  return ok({ done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
});
ipcMain.handle("post:cancel", () => { cancelRun = true; return ok(); });

// ---------- profile photos of connected accounts ----------
const avatarFile = (id) => path.join(dataDir(), "avatars", String(id).replace(/\D/g, "") + ".jpg");
const toDataUrl = (buf) => "data:image/jpeg;base64," + buf.toString("base64");

async function downloadAvatar(acc) {
  const c = await clientFor(acc);
  const me = await c.getMe();
  const f = avatarFile(acc.id);
  if (!me.photo || me.photo instanceof Api.UserProfilePhotoEmpty) {
    try { fs.unlinkSync(f); } catch {}
    return "";
  }
  const buf = await c.downloadProfilePhoto(me, { isBig: false });
  if (!buf || !buf.length) return "";
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  return toDataUrl(Buffer.from(buf));
}

// fresh=false: use the saved copy if we have one (fast, no Telegram request)
ipcMain.handle("acc:photo", async (_e, { id, fresh }) => {
  const acc = getAccounts().find((a) => a.id === id);
  if (!acc) return ok({ photo: "" });
  const f = avatarFile(id);
  if (!fresh && fs.existsSync(f)) return ok({ photo: toDataUrl(fs.readFileSync(f)) });
  try { return ok({ photo: await downloadAvatar(acc) }); }
  catch (e) { return fs.existsSync(f) ? ok({ photo: toDataUrl(fs.readFileSync(f)) }) : fail(e); }
});

// ---------- my stories: views + reactions ----------
const { strippedPhotoToJpg } = require("telegram/Utils");

function reactionText(r) {
  if (!r) return "";
  if (r instanceof Api.ReactionEmoji) return r.emoticon;
  if (r instanceof Api.ReactionPaid) return "⭐";
  return "💟"; // custom (premium) emoji: shown as a heart, the real sticker needs a download
}
function thumbOf(media) {
  const sizes = media?.photo?.sizes || media?.document?.thumbs || [];
  const s = sizes.find((x) => x instanceof Api.PhotoStrippedSize);
  if (!s) return "";
  try { return "data:image/jpeg;base64," + Buffer.from(strippedPhotoToJpg(s.bytes)).toString("base64"); } catch { return ""; }
}
function storySummary(st) {
  const v = st.views;
  const now = Math.floor(Date.now() / 1000);
  return {
    id: st.id,
    date: st.date,
    expires: st.expireDate,
    active: st.expireDate > now,
    caption: st.caption || "",
    kind: st.media instanceof Api.MessageMediaDocument ? "video" : "photo",
    thumb: thumbOf(st.media),
    views: v?.viewsCount || 0,
    reactionsCount: v?.reactionsCount || 0,
    reactions: (v?.reactions || []).map((r) => ({ emoji: reactionText(r.reaction), count: r.count })),
    hasViewers: !!v?.hasViewers,
  };
}

ipcMain.handle("stories:list", async (_e, id) => {
  const acc = getAccounts().find((a) => a.id === id);
  if (!acc) return fail("Account not found.");
  try {
    const c = await clientFor(acc);
    const self = new Api.InputPeerSelf();
    const [active, archive] = await Promise.all([
      c.invoke(new Api.stories.GetPeerStories({ peer: self })),
      c.invoke(new Api.stories.GetStoriesArchive({ peer: self, offsetId: 0, limit: 30 })).catch(() => null),
    ]);
    const map = new Map();
    for (const st of [...(archive?.stories || []), ...(active?.stories?.stories || [])]) {
      if (st instanceof Api.StoryItem) map.set(st.id, storySummary(st));
    }
    const list = [...map.values()].sort((a, b) => b.date - a.date);
    return ok({ stories: list, premium: acc.premium });
  } catch (e) { return fail(e); }
});

ipcMain.handle("stories:viewers", async (_e, { id, storyId, offset, reactionsFirst, q }) => {
  const acc = getAccounts().find((a) => a.id === id);
  if (!acc) return fail("Account not found.");
  try {
    const c = await clientFor(acc);
    const r = await c.invoke(new Api.stories.GetStoryViewsList({
      peer: new Api.InputPeerSelf(),
      id: storyId,
      offset: offset || "",
      limit: 50,
      reactionsFirst: !!reactionsFirst,
      q: q ? String(q).slice(0, 64) : undefined,
    }));
    const users = new Map(r.users.map((u) => [String(u.id), u]));
    const viewers = r.views.filter((v) => v instanceof Api.StoryView).map((v) => {
      const u = users.get(String(v.userId));
      return {
        id: String(v.userId),
        name: u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || "Deleted account" : "Unknown",
        username: u?.username || "",
        date: v.date,
        reaction: reactionText(v.reaction),
      };
    });
    return ok({ viewers, count: r.count, views: r.viewsCount, reactions: r.reactionsCount, next: r.nextOffset || "" });
  } catch (e) {
    const m = String(e?.errorMessage || e);
    if (m.includes("PREMIUM")) return fail("Telegram shows the viewer list only for 24h after a Story ends. After that it needs Premium (view counts still work).");
    return fail(e);
  }
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0b1020",
    title: "StoryCast",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", async () => {
  for (const id of [...clients.keys()]) await dropClient(id);
  app.quit();
});
