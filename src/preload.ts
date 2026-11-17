import { contextBridge, ipcRenderer } from "electron";

const INVOKE = [
  "state:get",
  "settings:update",
  "secret:set",
  "talk:audio",
  "talk:text",
  "talk:cancel",
  "talk:warm",
  "reminder:complete",
  "wake:audio",
  "talk:reset",
  "confirm:respond",
  "voice:clone",
  "voice:preview",
  "voice:remove",
  "connection:connect",
  "connection:disconnect",
  "open:external",
] as const;

const EVENTS = ["turn", "confirm:request", "shortcut:talk", "state:changed"] as const;

contextBridge.exposeInMainWorld("theo", {
  invoke(channel: (typeof INVOKE)[number], ...args: unknown[]) {
    if (!INVOKE.includes(channel)) throw new Error(`Unknown channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: (typeof EVENTS)[number], listener: (payload: unknown) => void) {
    if (!EVENTS.includes(channel)) throw new Error(`Unknown event ${channel}`);
    ipcRenderer.on(channel, (_event, payload) => listener(payload));
  },
});
