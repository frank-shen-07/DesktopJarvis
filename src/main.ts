import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import { resetConversation, respond } from "./agent";
import { appleScript, eventKit } from "./mac";
import {
  localVoiceInstalled,
  referencePath,
  removeReference,
  saveReference,
  speakLocally,
  stopLocalVoice,
  warmLocalVoice,
} from "./localVoice";
import { connectGmail, connectOutlook, disconnect, isConnected } from "./oauth";
import { afterWakeWord, cloneVoice, forSpeech, speechChunks, synthesize, transcribe } from "./speech";
import {
  getSecret,
  getSettings,
  hasSecret,
  SecretName,
  setSecret,
  Settings,
  updateSettings,
} from "./store";

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let activeTurn: AbortController | null = null;
const pendingConfirms = new Map<string, (approved: boolean) => void>();

const SETUP_LINKS = new Set([
  "https://platform.claude.com/settings/keys",
  "https://console.groq.com/keys",
  "https://platform.minimax.io/user-center/basic-information/interface-key",
  "https://console.cloud.google.com/apis/credentials",
  "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
]);

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

function showWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 1000,
    minHeight: 660,
    title: "Theo",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: "#020812",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void window.loadFile(path.join(app.getAppPath(), "renderer", "index.html"));
  window.once("ready-to-show", () => window?.show());
  // Closing the window keeps Theo in the menu bar, ready for the shortcut.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
}

function startTalking(): void {
  showWindow();
  send("shortcut:talk", null);
}

function registerShortcut(accelerator: string): boolean {
  globalShortcut.unregisterAll();
  if (!accelerator) return true;
  try {
    return globalShortcut.register(accelerator, startTalking);
  } catch {
    return false;
  }
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("Theo");
  tray.setToolTip("Theo");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Talk to Theo", click: startTalking },
      { label: "Show window", click: showWindow },
      { type: "separator" },
      { label: "Quit Theo", click: () => app.quit() },
    ]),
  );
}

// ---------- State shown in the interface ----------

interface Connection {
  id: "gmail" | "outlook" | "calendar" | "reminders" | "word";
  status: "connected" | "available" | "blocked";
  detail: string;
}

async function connections(): Promise<Connection[]> {
  const settings = getSettings();
  let access = { calendar: "notDetermined", reminders: "notDetermined" };
  try {
    access = await eventKit<typeof access>("status");
  } catch {
    // The helper is missing in an unbuilt checkout; treat as not yet connected.
  }
  const eventKitRow = (id: "calendar" | "reminders"): Connection => {
    const status = access[id];
    if (status === "granted") return { id, status: "connected", detail: "" };
    if (status === "notDetermined") return { id, status: "available", detail: "" };
    return { id, status: "blocked", detail: "Access was turned off in System Settings." };
  };
  return [
    {
      id: "gmail",
      status: isConnected("gmail") ? "connected" : "available",
      detail: isConnected("gmail") ? settings.gmailAddress : "",
    },
    {
      id: "outlook",
      status: isConnected("outlook") ? "connected" : "available",
      detail: isConnected("outlook") ? settings.outlookAddress : "",
    },
    eventKitRow("calendar"),
    eventKitRow("reminders"),
    { id: "word", status: settings.wordConnected ? "connected" : "available", detail: "" },
  ];
}

/** The recording the free voice imitates, if the person has made one. */
function clonedLocally(): { text: string } | null {
  const text = getSettings().localVoiceText;
  return text && fs.existsSync(referencePath()) ? { text } : null;
}

async function state() {
  const settings = getSettings();
  return {
    settings,
    keys: {
      anthropic: hasSecret("anthropic"),
      groq: hasSecret("groq"),
      minimax: hasSecret("minimax"),
      agentKey: hasSecret("agentKey"),
      googleClientSecret: hasSecret("googleClientSecret"),
    },
    connections: await connections(),
    localVoice: { installed: localVoiceInstalled(), cloned: Boolean(clonedLocally()) },
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
    packaged: app.isPackaged,
    shortcutActive: settings.shortcut ? globalShortcut.isRegistered(settings.shortcut) : false,
  };
}

async function announceState(): Promise<void> {
  send("state:changed", await state());
}

// ---------- One spoken turn ----------

function confirmWithPerson(request: { title: string; detail: string; action: string }): Promise<boolean> {
  const id = crypto.randomUUID();
  showWindow();
  return new Promise((resolve) => {
    pendingConfirms.set(id, resolve);
    send("confirm:request", { id, ...request });
  });
}

function cancelActiveTurn(): void {
  activeTurn?.abort();
  activeTurn = null;
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
}

async function speak(text: string, turnId: string, signal: AbortSignal): Promise<void> {
  const minimaxKey = getSecret("minimax");
  const settings = getSettings();
  const speakable = forSpeech(text);
  if (!speakable || signal.aborted) return;
  if (settings.localVoice && localVoiceInstalled()) {
    // The free voice makes one sentence at a time, so each is played as soon as it is ready.
    const chunks = speechChunks(speakable);
    for (let i = 0; i < chunks.length; i += 1) {
      try {
        const audio = await speakLocally(chunks[i], clonedLocally(), signal);
        if (signal.aborted) return;
        send("turn", { turnId, type: "audio", audio: new Uint8Array(audio) });
      } catch (error) {
        if (signal.aborted) return;
        send("turn", { turnId, type: "system-voice", text: chunks.slice(i).join(" ") });
        send("turn", {
          turnId,
          type: "notice",
          message: `Used the Mac's voice because ${error instanceof Error ? error.message : error}`,
        });
        return;
      }
    }
    return;
  }
  if (!minimaxKey) {
    // No voice service yet: the window falls back to the Mac's built-in voice.
    send("turn", { turnId, type: "system-voice", text: speakable });
    return;
  }
  const voiceId = settings.voiceId || settings.stockVoiceId;
  // Start every sentence at once, then hand them over in speaking order.
  const pending = speechChunks(speakable).map((chunk) =>
    synthesize(chunk, voiceId, minimaxKey, signal),
  );
  pending.forEach((job) => job.catch(() => undefined));
  try {
    for (const job of pending) {
      const audio = await job;
      if (signal.aborted) return;
      send("turn", { turnId, type: "audio", audio: new Uint8Array(audio) });
    }
  } catch (error) {
    if (signal.aborted) return;
    send("turn", { turnId, type: "system-voice", text: speakable });
    send("turn", {
      turnId,
      type: "notice",
      message: `Used the Mac's voice because ${error instanceof Error ? error.message : error}`,
    });
  }
}

async function runTurn(input: { audio?: ArrayBuffer; mimeType?: string; text?: string }): Promise<void> {
  cancelActiveTurn();
  const controller = new AbortController();
  activeTurn = controller;
  const turnId = crypto.randomUUID();
  // A turn that has been cancelled or replaced stays silent, so the window
  // only ever hears from the turn it is showing.
  const emit = (event: Record<string, unknown>) => {
    if (activeTurn === controller) send("turn", { turnId, ...event });
  };

  try {
    let heard = (input.text ?? "").trim();
    if (input.audio) {
      const groqKey = getSecret("groq");
      if (!groqKey) throw new Error("Add a Groq API key in Settings so Theo can hear you. Typing still works without it.");
      emit({ type: "status", status: "transcribing" });
      heard = await transcribe(Buffer.from(input.audio), input.mimeType ?? "audio/webm", groqKey, controller.signal);
    }
    if (!heard) {
      emit({ type: "done", empty: true });
      return;
    }
    emit({ type: "heard", text: heard });
    emit({ type: "status", status: "thinking" });

    const reply = await respond(
      heard,
      {
        confirm: confirmWithPerson,
        onToolStart: (id, label) => emit({ type: "tool", id, label, state: "running" }),
        onToolEnd: (id, ok) => emit({ type: "tool", id, state: ok ? "done" : "failed" }),
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    emit({ type: "reply", text: reply });
    await speak(reply, turnId, controller.signal);
    emit({ type: "done" });
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: "done", cancelled: true });
      return;
    }
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    emit({ type: "done" });
  } finally {
    if (activeTurn === controller) activeTurn = null;
  }
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle("state:get", () => state());

  ipcMain.handle("settings:update", async (_event, patch: Partial<Settings>) => {
    const allowed: (keyof Settings)[] = [
      "provider", "localVoice", "model", "groqModel", "localUrl", "localModel", "agentUrl", "agentModel", "agentTools", "shortcut", "wakeEnabled", "wakeWord", "keepListening", "confirmScripts", "stockVoiceId", "googleClientId", "microsoftClientId",
    ];
    const clean = Object.fromEntries(
      Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key as keyof Settings)),
    ) as Partial<Settings>;
    const settings = updateSettings(clean);
    if ("shortcut" in clean) registerShortcut(settings.shortcut);
    // Each service keeps its own conversation format, so switching starts afresh.
    if ("provider" in clean) resetConversation();
    // Load the free voice now so the first reply does not wait for it.
    if (clean.localVoice === true) warmLocalVoice();
    if (clean.localVoice === false) stopLocalVoice();
    return state();
  });

  ipcMain.handle("secret:set", async (_event, name: SecretName, value: string) => {
    if (!["anthropic", "groq", "minimax", "agentKey", "googleClientSecret"].includes(name)) {
      throw new Error("Unknown key");
    }
    setSecret(name, String(value ?? "").trim());
    return state();
  });

  ipcMain.handle("talk:audio", (_event, audio: ArrayBuffer, mimeType: string) => {
    void runTurn({ audio, mimeType });
  });
  ipcMain.handle("talk:text", (_event, text: string) => {
    void runTurn({ text: String(text ?? "") });
  });
  ipcMain.handle("talk:cancel", () => cancelActiveTurn());

  // A stretch of speech heard while idle: act on it only if it starts with the wake word.
  ipcMain.handle("wake:audio", async (_event, audio: ArrayBuffer) => {
    const settings = getSettings();
    const groqKey = getSecret("groq");
    if (!settings.wakeEnabled || !groqKey || activeTurn) return { matched: false };
    let heard: string;
    try {
      heard = await transcribe(Buffer.from(audio), "audio/wav", groqKey, undefined, settings.wakeWord);
    } catch (error) {
      return { matched: false, error: error instanceof Error ? error.message : String(error) };
    }
    const request = afterWakeWord(heard, settings.wakeWord);
    if (request === null || activeTurn) return { matched: false };
    if (request.split(/\s+/).filter(Boolean).length >= 2) {
      void runTurn({ text: request });
      return { matched: true, command: true };
    }
    // Just the wake word: the window opens the microphone for the request.
    return { matched: true, command: false };
  });
  ipcMain.handle("talk:reset", () => {
    cancelActiveTurn();
    resetConversation();
  });

  ipcMain.handle("confirm:respond", (_event, id: string, approved: boolean) => {
    pendingConfirms.get(id)?.(approved === true);
    pendingConfirms.delete(id);
  });

  ipcMain.handle(
    "voice:clone",
    async (_event, input: { audio: ArrayBuffer; filename: string; mimeType: string; consent: boolean }) => {
      if (input?.consent !== true) {
        throw new Error("Confirm that this is your voice or that you have permission to clone it");
      }
      const audio = Buffer.from(input.audio);
      if (audio.length > 20 * 1024 * 1024) throw new Error("The recording is larger than 20 MB");
      if (getSettings().localVoice) {
        // The free voice imitates a short sample and needs to know what is said in it.
        const groqKey = getSecret("groq");
        if (!groqKey) throw new Error("Add a Groq key in Settings first. Theo uses it to note down what your sample says.");
        const clip = await saveReference(audio, input.filename);
        const text = await transcribe(clip, "audio/wav", groqKey);
        if (!text) {
          removeReference();
          throw new Error("Theo could not make out any words in that recording");
        }
        updateSettings({ localVoiceText: text });
        const sample = await speakLocally(
          "Hello. This is how I sound now. Tell me what you need and I'll take care of it.",
          { text },
        );
        return { state: await state(), sample: new Uint8Array(sample) };
      }
      const minimaxKey = getSecret("minimax");
      if (!minimaxKey) throw new Error("Add a MiniMax API key in Settings first");
      const voiceId = await cloneVoice(audio, input.filename, input.mimeType, minimaxKey);
      updateSettings({ voiceId });
      // Speaking once with the new voice also activates it on MiniMax's side.
      const sample = await synthesize(
        "Hello. This is how I sound now. Tell me what you need and I'll take care of it.",
        voiceId,
        minimaxKey,
      );
      return { state: await state(), sample: new Uint8Array(sample) };
    },
  );

  ipcMain.handle("voice:preview", async () => {
    if (getSettings().localVoice) {
      return new Uint8Array(await speakLocally("Hello. This is the voice I'll use when we talk.", clonedLocally()));
    }
    const minimaxKey = getSecret("minimax");
    if (!minimaxKey) throw new Error("Add a MiniMax API key in Settings first");
    const settings = getSettings();
    const audio = await synthesize(
      "Hello. This is the voice I'll use when we talk.",
      settings.voiceId || settings.stockVoiceId,
      minimaxKey,
    );
    return new Uint8Array(audio);
  });

  ipcMain.handle("voice:remove", () => {
    if (getSettings().localVoice) {
      removeReference();
      updateSettings({ localVoiceText: "" });
      return state();
    }
    updateSettings({ voiceId: "" });
    return state();
  });

  ipcMain.handle("connection:connect", async (_event, id: string) => {
    if (id === "gmail") await connectGmail();
    else if (id === "outlook") await connectOutlook();
    else if (id === "calendar" || id === "reminders") {
      const result = await eventKit<{ granted: boolean }>("request", { kind: id });
      if (!result.granted) {
        throw new Error(
          `macOS did not grant access. Turn Theo on in System Settings › Privacy & Security › ${id === "calendar" ? "Calendars" : "Reminders"}.`,
        );
      }
    } else if (id === "word") {
      // Asking Word for its name triggers the one-time macOS automation prompt.
      await appleScript('tell application "Microsoft Word" to get name');
      updateSettings({ wordConnected: true });
    } else {
      throw new Error("Unknown connection");
    }
    showWindow();
    return state();
  });

  ipcMain.handle("connection:disconnect", (_event, id: string) => {
    if (id === "gmail" || id === "outlook") disconnect(id);
    if (id === "word") updateSettings({ wordConnected: false });
    return state();
  });

  ipcMain.handle("open:external", (_event, url: string) => {
    if (!SETUP_LINKS.has(url)) throw new Error("That link is not one Theo opens");
    return shell.openExternal(url);
  });
}

// ---------- App lifecycle ----------

// The global shortcut starts playback without a click inside the window.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    stopLocalVoice();
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    // Stay alive in the menu bar.
  });

  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === "media");
    });
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === "media");
    nativeTheme.themeSource = "dark";
    registerIpc();
    createWindow();
    createTray();
    registerShortcut(getSettings().shortcut);
    if (getSettings().localVoice) warmLocalVoice();
    void announceState();
  });
}
