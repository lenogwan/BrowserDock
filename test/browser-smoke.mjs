// Run against npm run dev. Real Chromium/Svelte UI with an injected Tauri IPC boundary.
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.BROWSERDOCK_PLAYWRIGHT_MODULE || "playwright"
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 400, height: 560 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.addInitScript(() => {
  window.isTauri = true;
  const callbacks = new Map(),
    listeners = new Map();
  let next = 0;
  const publicItems = [
    {
      id: "github",
      title: "GitHub",
      url: "https://github.com",
      target_browser: "firefox",
      tags: ["development"],
      icon: "",
    },
    {
      id: "docs",
      title: "Google Docs",
      url: "https://docs.google.com",
      target_browser: "chrome",
      tags: ["work"],
      icon: "",
    },
  ];
  const privateItems = [
    {
      id: "secret",
      title: "Private destination",
      url: "https://private.example",
      target_browser: "mullvad",
      tags: ["personal"],
      icon: "",
    },
  ];
  const groups = [{id:"work",name:"Work",color:"#b8edc9",sort_order:0,collapsed:false}];
  publicItems[1].group_id="work";
  const settings = {
    window_size:{width:400,height:null},
    always_on_top: true,
    auto_hide: false,
    opacity:1,
    hide_on_open:true,
    vault_timeout_minutes: 5,
    global_shortcut: "Ctrl+Shift+Space",
    panic_shortcut: "Ctrl+Alt+L",
  };
  const vault = { exists: true, locked: true, retry_after_seconds: 0 };
  window.testState = {
    calls: [],
    vault,
    settings,
    holdList: false,
    failMove:false,
    pendingList: null,
    publicItems,
  };
  window.emitTest = (event) => {
    for (const id of listeners.get(event) || [])
      callbacks.get(id)?.({ event, payload: null });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  const isGoogleHost = (raw) => {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      return host === "google.com" || host.endsWith(".google.com");
    } catch {
      return false;
    }
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    transformCallback(fn) {
      callbacks.set(++next, fn);
      return next;
    },
    async invoke(cmd, args = {}) {
      if (cmd !== "vault_auth") window.testState.calls.push({ cmd, args });
      switch (cmd) {
        case "dock_set_size":window.testState.pendingSize={...args};return;
        case "dock_commit_size":settings.window_size={...window.testState.pendingSize};return;
        case "dock_cancel_size":window.testState.pendingSize={...settings.window_size};return;
        case "plugin:event|listen": {
          const ids = listeners.get(args.event) || [];
          ids.push(args.handler);
          listeners.set(args.event, ids);
          return args.handler;
        }
        case "plugin:event|unlisten":
          return;
        case "get_dock_data":
          return structuredClone({
            bookmarks: publicItems,
            groups,
            browsers: [
              ["firefox", "Firefox"],
              ["mullvad", "Mullvad"],
              ["chrome", "Chrome"],
              ["edge", "Edge"],
            ].map(([id, name]) => ({
              id,
              name,
              color: "#b8edc9",
              exe_path: "",
            })),
            settings,
            warnings: [],
          });
        case "vault_status":
          return { ...vault };
        case "dock_hide":
        case "dock_escape":
          if (window.testState.failHide) throw new Error("Cannot hide dock. The window is still visible.");
          return;
        case "vault_list":
          if (window.testState.holdList)
            return new Promise(
              (resolve) =>
                (window.testState.pendingList = () =>
                  resolve(structuredClone(privateItems))),
            );
          return structuredClone(privateItems);
        case "vault_auth":
          vault.locked = false;
          return;
        case "vault_lock":
          vault.locked = true;
          window.emitTest("vault-locked");
          return;
        case "save_settings":
          Object.assign(settings, args.settings);
          return;
        case "save_bookmark": {
          const items = args.private ? privateItems : publicItems;
          const index = items.findIndex((b) => b.id === args.bookmark.id);
          if (index < 0) items.push(args.bookmark);
          else items[index] = args.bookmark;
          return;
        }
        case "delete_bookmark": {
          const items = args.private ? privateItems : publicItems;
          const index = items.findIndex((b) => b.id === args.id);
          if (index >= 0) items.splice(index, 1);
          return;
        }
        case "companion_status":
          return {
            instances: [
              {
                instance_id: "test",
                browser: "firefox",
                tabs: [
                  { id: 1, url: "https://github.com/pulls", title: "Pulls" },
                ],
              },
            ],
            error: null,
          };
        case "companion_tabs_digest":
          return {
            instances: [
              {
                instance_id: "test",
                browser: "firefox",
                tabs: [{ host: "github.com" }],
              },
            ],
            error: null,
          };
        case "browser_profiles": return ["Default", "Ray"];
        case "route_details": return {browser_id:args.browserId || (isGoogleHost(args.url)?"chrome":"firefox"),profile:args.browserId?null:"Ray"};
        case "save_group": {const i=groups.findIndex(g=>g.id===args.group.id);if(i<0)groups.push(args.group);else groups[i]=args.group;return;}
        case "move_bookmark": {
          if(window.testState.failMove)throw new Error("Move rejected");
          const item=publicItems.find(b=>b.id===args.id);item.group_id=args.groupId;item.sort_order=args.index;return;
        }
        case "route_url":
          return (
            args.browserId ||
            (isGoogleHost(args.url) ? "chrome" : "firefox")
          );
        case "open_url":
          return {
            result: "FOCUSED_EXISTING",
            browser_id: args.browserId || "firefox",
          };
        default:
          return;
      }
    },
  };
});
try {
  await page.goto("http://127.0.0.1:1420/");
  await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
  // Exercise accessible controls in the rendered UI, including the narrow dock.
  assert.equal(await page.getByRole('button',{name:'Settings',exact:true}).getAttribute('aria-label'),'Settings');
  assert.equal(await page.getByRole('button',{name:'Edit GitHub',exact:true}).getAttribute('aria-label'),'Edit GitHub');
  await page.getByText('Esc hide',{exact:false}).waitFor();
  await page.getByText('new tab',{exact:false}).waitFor();
  for (const width of [280,400,800]) {
    await page.setViewportSize({width,height:560});
    const layout=await page.locator('.pill').evaluate(el=>({
      overflow:el.scrollWidth>el.clientWidth,
      badges:[...el.querySelectorAll('.browser-badge')].map(b=>b.getBoundingClientRect().width),
      input:el.querySelector('input').getBoundingClientRect().width,
    }));
    assert.equal(layout.overflow,false,`Pill overflows at ${width}px`);
    assert.deepEqual(layout.badges,[23,23,23,23]);
    assert.ok(layout.input>40);
    assert.equal(await page.locator('footer').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    assert.equal(await page.locator('nav').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    if(width===280)await page.screenshot({path:'/tmp/browserdock-ui-280.png'});
  }
  await page.setViewportSize({width:400,height:560});
  await page.keyboard.press('Tab');
  for(const selector of ['.icon-button','.browser-badge','.group-title','.result-main']) {
    const control=page.locator(selector).first();
    await control.focus();
    assert.equal(await control.evaluate(el=>el.matches(':focus-visible')),true);
    assert.equal(await control.evaluate(el=>getComputedStyle(el).outlineStyle),'solid');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const selector of ['main','.browser-badge']) {
    assert.equal(await page.locator(selector).first().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  }
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.getByRole('button',{name:'Route to edge',exact:true}).click();
  await page.getByRole('button',{name:'Clear browser override',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Route to edge',exact:true}).getAttribute('aria-pressed'),'false');
  const search = page.getByRole("textbox", {
    name: "Search bookmarks or enter a URL",
  });
  await search.click();
  await page.getByRole("button", { name: "Open GitHub in firefox" }).waitFor();
  assert.equal(
    await page.locator("main").evaluate((el) => el.scrollWidth),
    398,
  );
  await search.fill("githb");
  assert.equal(
    await page.getByRole("button", { name: "Open GitHub in firefox" }).count(),
    1,
  );
  await search.fill("docs.google.com");
  await page.locator(".route-name").filter({hasText:"chrome · Ray"}).waitFor();
  await search.press("Alt+e");
  await search.press("Shift+Enter");
  const launch = await page.evaluate(() =>
    window.testState.calls.find((c) => c.cmd === "open_url"),
  );
  assert.equal(launch.args.browserId, "edge");
  assert.equal(launch.args.forceNewTab, true);
  await page.evaluate(() => window.emitTest("dock-summoned"));
  await search.fill("");
  await page.getByRole("button", { name: "Add bookmark", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Useful place");
  await page.getByLabel("URL", { exact: true }).fill("https://useful.example");
  await page
    .getByRole("button", { name: "Save bookmark", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Useful place in firefox" })
    .waitFor();
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill("valid secret");
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Private destination in mullvad" })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.emitTest("dock-summoned"));
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Private destination in mullvad" })
    .waitFor();
  // Lock unmounts private results and any editor immediately.
  await page.evaluate(() => {
    window.testState.vault.locked = true;
    window.emitTest("vault-locked");
  });
  assert.equal(
    await page
      .getByRole("button", { name: "Open Private destination in mullvad" })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill("must disappear");
  await page.evaluate(() => window.emitTest("vault-locked"));
  assert.equal(await page.locator("input[type=password]").count(), 0);
  // A private list response arriving after panic cannot repopulate the DOM/search.
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.getByLabel("Passphrase", { exact: true }).fill("valid secret");
  await page.evaluate(() => (window.testState.holdList = true));
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
  await page.waitForFunction(() => window.testState.pendingList !== null);
  await page.evaluate(() => {
    window.testState.vault.locked = true;
    window.emitTest("vault-locked");
    window.testState.pendingList();
  });
  await page.waitForTimeout(100);
  assert.equal(
    await page
      .getByRole("button", { name: "Open Private destination in mullvad" })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.evaluate(() => { window.testState.failHide = true; });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Open GitHub in firefox" }).click();
  await page.getByRole("alert").filter({hasText:"Cannot hide dock"}).waitFor();
  assert.equal(await page.getByRole("button", { name: "Open GitHub in firefox" }).isVisible(), true);
  await search.press("Escape");
  assert.equal(await page.getByRole("button", { name: "Open GitHub in firefox" }).isVisible(), true);
  await page.evaluate(() => { window.testState.failHide = false; });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const opacity=page.getByRole("slider");
  await opacity.fill("0.45");
  assert.equal(await page.locator("main").evaluate(el=>el.style.getPropertyValue("--dock-opacity")),"0.45");
  await page.getByLabel("Hide after opening").uncheck();
  await page.getByLabel("Auto-hide").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForFunction(()=>window.testState.settings.opacity===0.45);
  assert.equal(await page.evaluate(()=>window.testState.settings.hide_on_open),false);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button",{name:"Open GitHub in firefox"}).click();
  assert.equal(await page.getByRole("button",{name:"Open GitHub in firefox"}).isVisible(),true);
  // A failed drag restores the source section and reports the persistence error.
  await page.evaluate(()=>window.testState.failMove=true);
  const github=page.locator(".result").filter({has:page.getByRole("button",{name:"Open GitHub in firefox"})});
  const work=page.locator(".results section").filter({has:page.getByRole("button",{name:"Edit group Work",exact:true})});
  await github.dragTo(work);
  await page.getByRole("alert").filter({hasText:"Move rejected"}).waitFor();
  assert.equal(await page.evaluate(()=>window.testState.publicItems.find(b=>b.id==='github').group_id), undefined);
  await page.evaluate(()=>window.testState.failMove=false);
  await github.dragTo(work);
  await work.getByRole("button",{name:"Open GitHub in firefox"}).waitFor();
  await page.getByRole("button",{name:"Edit GitHub",exact:true}).click();
  await page.getByLabel("Group",{exact:true}).selectOption("");
  await page.getByRole("button",{name:"Save bookmark",exact:true}).click();
  await page.waitForFunction(()=>window.testState.calls.filter(c=>c.cmd==='save_bookmark').at(-1)?.args.bookmark.group_id===null);
  await page.waitForFunction(()=>!window.testState.calls.some(c=>c.cmd==='save_bookmark' && c.args.bookmark.group_id===undefined));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.testState.publicItems.find(b=>b.id==='github').group_id), null);
  await page.locator("main").dispatchEvent("mouseleave");
  await page.evaluate(() => window.emitTest("dock-summoned"));
  await search.fill("github");
  await page.waitForTimeout(950);
  assert.equal(await search.isVisible(), true);
  assert.equal(await search.inputValue(), "github");
  await search.fill("");
  await page.screenshot({ path: "/tmp/browserdock-dock.png" });
  await page.getByRole("button", { name: "Vault", exact: true }).click();
  await page.screenshot({ path: "/tmp/browserdock-vault.png" });
  // Numeric settings preview is discarded on navigation, and Save persists both modes.
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Window width',exact:true}).fill('620');
  await page.waitForFunction(()=>window.testState.pendingSize?.width===620);
  assert.equal(await page.evaluate(()=>window.testState.settings.window_size.width),400);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.waitForFunction(()=>window.testState.pendingSize?.width===400);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Window width',exact:true}).fill('620');
  await page.getByLabel('Automatic height').uncheck();
  await page.getByRole('spinbutton',{name:'Window height',exact:true}).fill('480');
  await page.getByRole('button',{name:'Save settings',exact:true}).click();
  await page.waitForFunction(()=>window.testState.settings.window_size.height===480);
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Resize dock',exact:true}).dblclick();
  await page.waitForFunction(()=>window.testState.settings.window_size.width===400&&window.testState.settings.window_size.height===null);
  const grip=page.getByRole('button',{name:'Resize dock',exact:true});
  const box=await grip.boundingBox();
  const commitsBefore=await page.evaluate(()=>window.testState.calls.filter(c=>c.cmd==='dock_commit_size').length);
  await page.mouse.move(box.x+8,box.y+8);await page.mouse.down();
  await page.mouse.move(box.x-32,box.y+8,{steps:4});await page.mouse.up();
  await page.waitForFunction(()=>window.testState.settings.window_size.width===360);
  assert.equal(await page.evaluate(()=>window.testState.settings.window_size.height),null);
  assert.equal(await page.evaluate(()=>window.testState.calls.filter(c=>c.cmd==='dock_commit_size').length),commitsBefore+1);
  await page.mouse.move(box.x+8,box.y+8);await page.mouse.down();
  await page.mouse.move(box.x+8,box.y-42,{steps:4});await page.mouse.up();
  await page.waitForFunction(()=>window.testState.settings.window_size.height===510);
  await grip.dblclick();
  await page.waitForFunction(()=>window.testState.settings.window_size.height===null);
  await page.setViewportSize({width:280,height:560});
  assert.equal(await page.locator('main').evaluate(el=>el.scrollWidth),278);
  await page.setViewportSize({width:620,height:480});
  assert.equal(await page.locator('main').evaluate(el=>el.getBoundingClientRect().width),620);
  await page.locator('main').dispatchEvent('mouseleave');
  await page.getByRole('button',{name:'Expand BrowserDock',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Resize dock',exact:true}).count(),0);
  await page.getByRole('button',{name:'Expand BrowserDock',exact:true}).click({force:true});
  await page.getByRole('button',{name:'Resize dock',exact:true}).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Browser UI smoke passed: search, routing, force-new-tab, bookmark CRUD, Escape restore, panic clearing, stale private response, auto-hide cancellation, layout.",
  );
} finally {
  await browser.close();
}
