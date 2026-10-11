import { contextBridge, ipcRenderer } from 'electron';
import type { HudBridge } from '../shared/types';

const on = (channel: string) => (cb: (p: any) => void) => {
  ipcRenderer.on(channel, (_e, payload) => cb(payload));
};

const bridge: HudBridge = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  toolManifest: () => ipcRenderer.invoke('tools:manifest'),
  hotkeys: () => ipcRenderer.invoke('app:hotkeys'),
  execTool: (name, args) => ipcRenderer.invoke('tools:exec', name, args),
  stats: () => ipcRenderer.invoke('stats:get'),
  screenFrame: () => ipcRenderer.invoke('screen:frame'),
  putVisual: (id, html) => ipcRenderer.invoke('visual:put', id, html),
  setHitRects: (rects) => ipcRenderer.send('hit:rects', rects),
  setHitLock: (locked) => ipcRenderer.send('hit:lock', locked),
  focus: () => ipcRenderer.send('win:focus'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  hide: () => ipcRenderer.send('win:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  onHotkey: on('hotkey'),
  onFx: on('fx'),
  onEvent: on('event'),
};

contextBridge.exposeInMainWorld('hud', bridge);
