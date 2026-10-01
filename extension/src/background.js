const extensionApi = globalThis.browser ?? globalThis.chrome;
if (!extensionApi?.tabs || !extensionApi?.storage || typeof WebSocket === "undefined") {
  throw new Error("BrowserDock Companion requires the tabs/storage extension APIs and WebSocket.");
}
const companion = new Companion(extensionApi, url => new WebSocket(url));
void companion.start();
