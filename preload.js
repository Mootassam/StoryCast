const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = (ch) => (arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld("sc", {
  getConfig: call("config:get"),
  setConfig: call("config:set"),
  openApiSite: call("open:apisite"),
  sendCode: call("acc:sendCode"),
  signIn: call("acc:signIn"),
  password: call("acc:password"),
  cancelLogin: call("acc:cancel"),
  listAccounts: call("acc:list"),
  removeAccount: call("acc:remove"),
  checkAccount: call("acc:check"),
  accountPhoto: call("acc:photo"),
  pickMedia: call("media:pick"),
  mediaInfo: call("media:info"),
  pathOf: (f) => webUtils.getPathForFile(f),
  post: call("post:start"),
  cancelPost: call("post:cancel"),
  listStories: call("stories:list"),
  viewers: call("stories:viewers"),
  viewerPhoto: call("stories:viewerPhoto"),
  storyThumb: call("stories:thumb"),
  storyFull: call("stories:full"),
  deleteStories: call("stories:delete"),
  onFullProgress: (fn) => ipcRenderer.on("stories:fullProgress", (_e, v) => fn(v)),
  onProgress: (fn) => ipcRenderer.on("post:progress", (_e, v) => fn(v)),
});
