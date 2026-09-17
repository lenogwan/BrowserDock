const extensionApi = globalThis.browser ?? globalThis.chrome;
if (!extensionApi?.tabs || !extensionApi?.storage || typeof WebSocket === "undefined") {
  throw new Error("BrowserDock Companion requires the tabs/storage extension APIs and WebSocket.");
}
const companion = new Companion(extensionApi, url => new WebSocket(url));
if (extensionApi.action?.onClicked) {
  extensionApi.action.onClicked.addListener(() => {
    Promise.resolve(extensionApi.runtime.openOptionsPage()).catch(() => {});
  });
}
void companion.start();
