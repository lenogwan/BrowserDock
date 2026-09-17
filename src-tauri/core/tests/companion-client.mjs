// Live protocol fixture: production companion, real WebSocket, controlled browser API.
import { Companion } from '../../../extension/src/core.js';

const event = () => ({ addListener() {} });
let tabs = [{ id: 1, windowId: 10, url: 'https://github.com/pulls', title: 'Pulls', incognito: false }];
const api = {
  storage: { local: { async get() { return { pairing: { browser: 'firefox', port: Number(process.argv[2]), token: process.argv[3] } }; } }, onChanged: event() },
  tabs: {
    async query() { return tabs; },
    async update(id) { return tabs.find(t => t.id === id); },
    async create({ url, windowId }) { const tab = { id: tabs.length + 1, url, windowId, title: 'New', incognito: false }; tabs.push(tab); return tab; },
    ...Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onAttached', 'onDetached', 'onReplaced'].map(name => [name, event()])),
  },
  windows: { async getAll() { return [{ id: 10, incognito: false }]; }, async update(id) { return { id }; } },
  alarms: { create() {}, onAlarm: event() },
  runtime: { onStartup: event(), onInstalled: event() },
};
const companion = new Companion(api, endpoint => new WebSocket(endpoint));
await companion.start();
