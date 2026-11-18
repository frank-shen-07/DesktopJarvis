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
  type NativeImage,
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
import { chooseAck, keptPhrase, preparePhrases, sentencesOf } from "./phrases";
import { afterWakeWord, cloneVoice, forSpeech, synthesize, transcribe, transcribeOverheard } from "./speech";
import { getSecret, getSettings, hasSecret, type SecretName, setSecret, type Settings, updateSettings } from "./store";

// The app used to be called Theo, and Electron names its data folder after the app.
// Keep using the old folder so settings, mail sign-ins, the voice and cached phrases stay.
app.setPath("userData", path.join(app.getPath("appData"), "theo-desktop"));

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
    title: "DesktopJarvis",
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
  // `npm run dev` serves the window from Vite so edits show up straight away; otherwise
  // it is the copy Vite built into dist/renderer.
  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer && !app.isPackaged) void window.loadURL(devServer);
  else void window.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  window.once("ready-to-show", () => window?.show());
  // Closing the window keeps DesktopJarvis in the menu bar, ready for the shortcut.
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

// The menu bar icon, drawn in assets/tray-icon.svg; `npm run build:icon` makes these PNGs. A
// template image is recoloured by macOS to suit light and dark menu bars, and the @2x copy of
// each is used on Retina screens.
const TRAY_DIR = path.join(app.getAppPath(), "dist", "tray");
let trayIdle: NativeImage = nativeImage.createEmpty();
let trayFire: { frames: NativeImage[]; intervalMs: number } = { frames: [], intervalMs: 0 };
let trayFlicker: NodeJS.Timeout | undefined;

function trayImage(name: string): NativeImage {
  const image = nativeImage.createFromPath(path.join(TRAY_DIR, `${name}.png`));
  image.setTemplateImage(true);
  return image;
}

function loadTrayFire(): typeof trayFire {
  try {
    const { frames, intervalMs } = JSON.parse(fs.readFileSync(path.join(TRAY_DIR, "frames.json"), "utf8"));
    return { frames: Array.from({ length: frames }, (_, i) => trayImage(`trayFire${i}Template`)), intervalMs };
  } catch {
    // Not built yet: the icon just stays still.
    return { frames: [], intervalMs: 0 };
  }
}

/** While a request is being worked on, the dragon's fire flickers in the menu bar. */
function setTrayBusy(busy: boolean): void {
  clearInterval(trayFlicker);
  trayFlicker = undefined;
  if (!tray) return;
  if (!busy || !trayFire.frames.length) {
    tray.setImage(trayIdle);
    return;
  }
  let frame = 0;
  trayFlicker = setInterval(() => {
    tray?.setImage(trayFire.frames[frame]);
    frame = (frame + 1) % trayFire.frames.length;
  }, trayFire.intervalMs);
}

function createTray(): void {
  trayIdle = trayImage("trayTemplate");
  trayFire = loadTrayFire();
  tray = new Tray(trayIdle);
  // Without the icon (not built yet) the menu bar would show nothing at all.
  if (trayIdle.isEmpty()) tray.setTitle("DesktopJarvis");
  tray.setToolTip("DesktopJarvis");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Talk to DesktopJarvis", click: startTalking },
      { label: "Show window", click: showWindow },
      { type: "separator" },
      { label: "Quit DesktopJarvis", click: () => app.quit() },
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
  setTrayBusy(false);
  for (const resolve of pendingConfirms.values()) resolve(false);
  pendingConfirms.clear();
}

// ---------- Speaking ----------

type Voice =
  | { kind: "system" }
  | { kind: "local"; key: string; make(text: string, signal?: AbortSignal): Promise<Buffer> }
  | { kind: "minimax"; key: string; make(text: string, signal?: AbortSignal): Promise<Buffer> };

/** Which voice DesktopJarvis speaks with right now, and how to make audio in it. */
function currentVoice(): Voice {
  const settings = getSettings();
  if (settings.localVoice && localVoiceInstalled()) {
    const cloned = clonedLocally();
    let sample = "standard";
    if (cloned) {
      try {
        sample = `${fs.statSync(referencePath()).mtimeMs}:${cloned.text}`;
      } catch {
        // The recording has just been removed.
      }
    }
    return { kind: "local", key: `local:${sample}`, make: (text, signal) => speakLocally(text, cloned, signal) };
  }
  const minimaxKey = getSecret("minimax");
  // No voice service yet: the window falls back to the Mac's built-in voice.
  if (!minimaxKey) return { kind: "system" };
  const voiceId = settings.voiceId || settings.stockVoiceId;
  return {
    kind: "minimax",
    key: `minimax:${voiceId}`,
    make: (text, signal) => synthesize(text, voiceId, minimaxKey, signal),
  };
}

/** Get the quick acknowledgements ready in the current voice, in the background. */
function prepareQuickReplies(): void {
  const voice = currentVoice();
  if (voice.kind === "system" || !getSettings().quickReplies) return;
  void preparePhrases(voice.key, (text) => voice.make(text));
}

/**
 * Everything DesktopJarvis says in one turn, in the order it was asked to say it. Each piece
 * starts being turned into audio the moment it arrives, and is handed to the window
 * as soon as it and everything before it is ready.
 *
 * Words meant for the log (`kind`) are sent to the window straight away with an id, and
 * each piece of audio carries the same id: the window shows the words when their audio
 * starts, so what is on screen keeps pace with what is heard.
 */
function createSpeaker(signal: AbortSignal, emit: (event: Record<string, unknown>) => void) {
  const voice = currentVoice();
  let line: Promise<void> = Promise.resolve();
  let fellBack = false;
  let lastSaidAt = 0;
  let firstAudioAt = 0;
  let pieces = 0;
  // The voice on this Mac takes about as long to make a piece as to say it, and every
  // piece costs it extra time for the sample it imitates. Pieces of a sentence or more
  // keep it ahead of itself; with short ones it falls behind and leaves gaps.
  const sizes = voice.kind === "local" ? { first: 60 } : {};

  function sayPiece(words: string, options: { keep?: boolean; kind?: "note" | "reply" }): void {
    const id = options.kind ? String((pieces += 1)) : undefined;
    if (id) emit({ type: "say", id, text: words, kind: options.kind });
    const speakable = forSpeech(words);
    if (!speakable) {
      // Nothing to hear, such as a bare link: it is shown when the voice reaches it.
      if (id) line = line.then(() => (signal.aborted ? undefined : emit({ type: "silent", id })));
      return;
    }
    const make = () => {
      if (voice.kind === "system") throw new Error("no voice service");
      return options.keep
        ? keptPhrase(voice.key, speakable, () => voice.make(speakable))
        : voice.make(speakable, signal);
    };
    // MiniMax makes several pieces at once; the voice on this Mac makes one at a time.
    const early = voice.kind === "minimax" && !fellBack ? make() : null;
    early?.catch(() => undefined);
    line = line.then(async () => {
      if (signal.aborted) return;
      if (voice.kind === "system" || fellBack) {
        firstAudioAt ||= Date.now();
        emit({ type: "system-voice", id, text: speakable });
        return;
      }
      try {
        const audio = await (early ?? make());
        if (signal.aborted) return;
        firstAudioAt ||= Date.now();
        emit({ type: "audio", id, audio: new Uint8Array(audio) });
      } catch (error) {
        if (signal.aborted) return;
        // The Mac's own voice finishes this turn.
        fellBack = true;
        emit({ type: "system-voice", id, text: speakable });
        emit({
          type: "notice",
          message: `Used the Mac's voice because ${error instanceof Error ? error.message : error}`,
        });
      }
    });
  }

  function say(text: string, options: { keep?: boolean; kind?: "note" | "reply" } = {}): void {
    if (signal.aborted || !text.trim()) return;
    lastSaidAt = Date.now();
    for (const piece of sentencesOf(text, sizes)) sayPiece(piece, options);
  }

  return {
    say,
    /** Resolves once everything said so far has been handed to the window. */
    finished: () => line,
    lastSaidAt: () => lastSaidAt,
    firstAudioAt: () => firstAudioAt,
  };
}

/**
 * Open connections to the services a turn is about to use, so the turn itself does not
 * wait for them. The replies are ignored; reaching the service is the point.
 */
function warmConnections(...urls: string[]): void {
  for (const url of urls) {
    fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000) }).catch(() => undefined);
  }
}

function warmForThinking(): void {
  const settings = getSettings();
  if (settings.provider === "claude") warmConnections("https://api.anthropic.com");
  if (!settings.localVoice && hasSecret("minimax")) warmConnections("https://api-uw.minimax.io");
}

// A step is named out loud only after this much quiet, so quick work is not narrated.
const QUIET_BEFORE_NAMING_STEP_MS = 1800;
// A request that did not sound like work is acknowledged only if the answer is this slow.
const SLOW_ANSWER_MS = 2000;

async function runTurn(input: { audio?: ArrayBuffer; mimeType?: string; text?: string }): Promise<void> {
  cancelActiveTurn();
  const controller = new AbortController();
  activeTurn = controller;
  setTrayBusy(true);
  const turnId = crypto.randomUUID();
  // A turn that has been cancelled or replaced stays silent, so the window
  // only ever hears from the turn it is showing.
  const emit = (event: Record<string, unknown>) => {
    if (activeTurn === controller) send("turn", { turnId, ...event });
  };
  const startedAt = Date.now();
  let heardAt = 0;
  let slowAnswer: NodeJS.Timeout | undefined;

  try {
    let heard = (input.text ?? "").trim();
    if (input.audio) {
      const groqKey = getSecret("groq");
      if (!groqKey)
        throw new Error("Add a Groq API key in Settings so DesktopJarvis can hear you. Typing still works without it.");
      emit({ type: "status", status: "transcribing" });
      warmForThinking();
      heard = await transcribe(Buffer.from(input.audio), input.mimeType ?? "audio/webm", groqKey, controller.signal);
    }
    if (!heard) {
      emit({ type: "done", empty: true });
      return;
    }
    heardAt = Date.now();
    emit({ type: "heard", text: heard });
    emit({ type: "status", status: "thinking" });

    const speaker = createSpeaker(controller.signal, emit);
    const quick = getSettings().quickReplies;
    const ack = chooseAck(heard);
    let answering = false;
    const acknowledge = () => {
      if (answering || speaker.lastSaidAt() || controller.signal.aborted) return;
      speaker.say(ack.text, { keep: true });
    };
    if (quick && ack.instant) acknowledge();
    else if (quick) slowAnswer = setTimeout(acknowledge, SLOW_ANSWER_MS);

    await respond(
      heard,
      {
        request: heard,
        confirm: confirmWithPerson,
        show: (section) => emit({ type: "board", section }),
        onToolStart: (id, label, fixed) => {
          emit({ type: "tool", id, label, state: "running" });
          // Name the step out loud when DesktopJarvis has been quiet for a while.
          if (quick && Date.now() - speaker.lastSaidAt() > QUIET_BEFORE_NAMING_STEP_MS) {
            speaker.say(`${label}.`, { keep: fixed });
          }
        },
        onToolEnd: (id, ok) => emit({ type: "tool", id, state: ok ? "done" : "failed" }),
        onWriting: () => {
          answering = true;
        },
        onSpeech: (text, kind) => speaker.say(text, { kind }),
      },
      controller.signal,
    );
    clearTimeout(slowAnswer);
    if (controller.signal.aborted) return;
    await speaker.finished();
    emit({ type: "done", ok: true });
    console.info(
      `[theo] turn: heard after ${heardAt - startedAt} ms, first audio ${speaker.firstAudioAt() ? `${speaker.firstAudioAt() - heardAt} ms` : "none"} after that, finished ${Date.now() - heardAt} ms after that`,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      emit({ type: "done", cancelled: true });
      return;
    }
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    emit({ type: "done" });
  } finally {
    clearTimeout(slowAnswer);
    if (activeTurn === controller) {
      activeTurn = null;
      setTrayBusy(false);
    }
  }
}

// ---------- IPC ----------

/** Settings the window may change. Everything else is managed by DesktopJarvis itself. */
const EDITABLE_SETTINGS = new Set<keyof Settings>([
  "provider",
  "localVoice",
  "model",
  "groqModel",
  "localUrl",
  "localModel",
  "agentUrl",
  "agentModel",
  "agentTools",
  "shortcut",
  "wakeEnabled",
  "wakeWord",
  "keepListening",
  "quickReplies",
  "confirmScripts",
  "stockVoiceId",
  "googleClientId",
  "microsoftClientId",
]);

/** Keys the window may store. */
const EDITABLE_SECRETS = new Set<SecretName>(["anthropic", "groq", "minimax", "agentKey", "googleClientSecret"]);

const CLONE_SAMPLE = "Hello. This is how I sound now. Tell me what you need and I'll take care of it.";
const PREVIEW_SAMPLE = "Hello. This is the voice I'll use when we talk.";

function registerIpc(): void {
  registerSettingsIpc();
  registerTalkIpc();
  registerVoiceIpc();
  registerConnectionIpc();
}

function registerSettingsIpc(): void {
  ipcMain.handle("state:get", () => state());

  ipcMain.handle("settings:update", async (_event, patch: Partial<Settings>) => {
    const clean = Object.fromEntries(
      Object.entries(patch ?? {}).filter(([key]) => EDITABLE_SETTINGS.has(key as keyof Settings)),
    ) as Partial<Settings>;
    const settings = updateSettings(clean);
    if ("shortcut" in clean) registerShortcut(settings.shortcut);
    // Each service keeps its own conversation format, and what DesktopJarvis is told must not
    // change partway through a conversation, so these start a fresh one.
    if ("provider" in clean || "model" in clean || "quickReplies" in clean) resetConversation();
    // Load the free voice now so the first reply does not wait for it.
    if (clean.localVoice === true) warmLocalVoice();
    if (clean.localVoice === false) stopLocalVoice();
    prepareQuickReplies();
    return state();
  });

  ipcMain.handle("secret:set", async (_event, name: SecretName, value: string) => {
    if (!EDITABLE_SECRETS.has(name)) throw new Error("Unknown key");
    setSecret(name, String(value ?? "").trim());
    prepareQuickReplies();
    return state();
  });

  ipcMain.handle("open:external", (_event, url: string) => {
    if (!SETUP_LINKS.has(url)) throw new Error("That link is not one DesktopJarvis opens");
    return shell.openExternal(url);
  });
}

function registerTalkIpc(): void {
  ipcMain.handle("talk:audio", (_event, audio: ArrayBuffer, mimeType: string) => {
    void runTurn({ audio, mimeType });
  });
  ipcMain.handle("talk:text", (_event, text: string) => {
    void runTurn({ text: String(text ?? "") });
  });
  ipcMain.handle("talk:cancel", () => cancelActiveTurn());
  // The microphone has just opened: reach the transcription service before it is needed.
  ipcMain.handle("talk:warm", () => {
    if (hasSecret("groq")) warmConnections("https://api.groq.com");
  });
  // A reminder ticked off on the board.
  ipcMain.handle("reminder:complete", async (_event, id: string) => {
    await eventKit("complete-reminder", { id: String(id ?? "") });
  });

  // A stretch of speech heard while idle: act on it only if it starts with the wake word.
  ipcMain.handle("wake:audio", async (_event, audio: ArrayBuffer) => {
    const settings = getSettings();
    const groqKey = getSecret("groq");
    if (!settings.wakeEnabled || !groqKey || activeTurn) return { matched: false };
    let heard: { text: string; doubt: string };
    try {
      heard = await transcribeOverheard(Buffer.from(audio), groqKey);
    } catch (error) {
      return { matched: false, error: error instanceof Error ? error.message : String(error) };
    }
    const request = heard.doubt ? null : afterWakeWord(heard.text, settings.wakeWord);
    // While developing, show what was overheard and why it did or did not wake DesktopJarvis.
    if (!app.isPackaged) {
      let verdict = "woke DesktopJarvis";
      if (heard.doubt) verdict = `ignored, ${heard.doubt}`;
      else if (request === null) verdict = "ignored, no wake word at the start";
      console.info(`[theo] wake: heard "${heard.text}", ${verdict}`);
    }
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
}

function registerVoiceIpc(): void {
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
        if (!groqKey)
          throw new Error(
            "Add a Groq key in Settings first. DesktopJarvis uses it to note down what your sample says.",
          );
        const clip = await saveReference(audio, input.filename);
        const text = await transcribe(clip, "audio/wav", groqKey);
        if (!text) {
          removeReference();
          throw new Error("DesktopJarvis could not make out any words in that recording");
        }
        updateSettings({ localVoiceText: text });
        const sample = await speakLocally(CLONE_SAMPLE, { text });
        prepareQuickReplies();
        return { state: await state(), sample: new Uint8Array(sample) };
      }
      const minimaxKey = getSecret("minimax");
      if (!minimaxKey) throw new Error("Add a MiniMax API key in Settings first");
      const voiceId = await cloneVoice(audio, input.filename, input.mimeType, minimaxKey);
      updateSettings({ voiceId });
      // Speaking once with the new voice also activates it on MiniMax's side.
      const sample = await synthesize(CLONE_SAMPLE, voiceId, minimaxKey);
      prepareQuickReplies();
      return { state: await state(), sample: new Uint8Array(sample) };
    },
  );

  ipcMain.handle("voice:preview", async () => {
    if (getSettings().localVoice) {
      return new Uint8Array(await speakLocally(PREVIEW_SAMPLE, clonedLocally()));
    }
    const minimaxKey = getSecret("minimax");
    if (!minimaxKey) throw new Error("Add a MiniMax API key in Settings first");
    const settings = getSettings();
    const audio = await synthesize(PREVIEW_SAMPLE, settings.voiceId || settings.stockVoiceId, minimaxKey);
    return new Uint8Array(audio);
  });

  ipcMain.handle("voice:remove", () => {
    if (getSettings().localVoice) {
      removeReference();
      updateSettings({ localVoiceText: "" });
    } else {
      updateSettings({ voiceId: "" });
    }
    prepareQuickReplies();
    return state();
  });
}

function registerConnectionIpc(): void {
  ipcMain.handle("connection:connect", async (_event, id: string) => {
    if (id === "gmail") await connectGmail();
    else if (id === "outlook") await connectOutlook();
    else if (id === "calendar" || id === "reminders") {
      const result = await eventKit<{ granted: boolean }>("request", { kind: id });
      if (!result.granted) {
        throw new Error(
          `macOS did not grant access. Turn DesktopJarvis on in System Settings › Privacy & Security › ${id === "calendar" ? "Calendars" : "Reminders"}.`,
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
    prepareQuickReplies();
    void announceState();
  });
}
