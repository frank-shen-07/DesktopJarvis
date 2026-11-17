import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";

export type Provider = "claude" | "groq" | "local" | "agent";

export interface Settings {
  /** Which service does the thinking. */
  provider: Provider;
  /** Claude model id. */
  model: string;
  groqModel: string;
  /** Base URL of an OpenAI-compatible server such as Ollama or LM Studio. */
  localUrl: string;
  localModel: string;
  /** Base URL of another agent's OpenAI-compatible endpoint, such as OpenClaw's gateway. */
  agentUrl: string;
  /** Which agent to talk to there, in that agent's own naming. */
  agentModel: string;
  /** Offer DesktopJarvis's own Mac tools to the agent alongside whatever it can already do. */
  agentTools: boolean;
  shortcut: string;
  /** Listen all the time and respond when the wake word is heard. */
  wakeEnabled: boolean;
  wakeWord: string;
  keepListening: boolean;
  /** Say "On it" as soon as a request is heard, and say what DesktopJarvis is doing while it works. */
  quickReplies: boolean;
  confirmScripts: boolean;
  /** MiniMax voice id of the user's clone; empty until they create one. */
  voiceId: string;
  /** Speak with the free model on this Mac instead of MiniMax or the Mac's built-in voice. */
  localVoice: boolean;
  /** What is said in the recording the free voice imitates; empty until one is made. */
  localVoiceText: string;
  /** MiniMax stock voice used before a clone exists. */
  stockVoiceId: string;
  googleClientId: string;
  microsoftClientId: string;
  gmailAddress: string;
  outlookAddress: string;
  wordConnected: boolean;
}

export type SecretName =
  | "anthropic"
  | "groq"
  | "minimax"
  | "agentKey"
  | "googleClientSecret"
  | "googleRefresh"
  | "microsoftRefresh";

const defaults: Settings = {
  provider: "claude",
  model: "claude-opus-5-5",
  groqModel: "openai/gpt-oss-120b",
  localUrl: "http://localhost:11434/v1",
  localModel: "",
  agentUrl: "http://127.0.0.1:18789/v1",
  agentModel: "openclaw/default",
  agentTools: false,
  shortcut: "Alt+Space",
  wakeEnabled: false,
  wakeWord: "Jarvis",
  keepListening: false,
  quickReplies: true,
  confirmScripts: true,
  voiceId: "",
  localVoice: false,
  localVoiceText: "",
  stockVoiceId: "English_expressive_narrator",
  googleClientId: "",
  microsoftClientId: "",
  gmailAddress: "",
  outlookAddress: "",
  wordConnected: false,
};

interface FileShape {
  settings: Partial<Settings>;
  secrets: Partial<Record<SecretName, string>>;
}

let cache: FileShape | null = null;

function filePath(): string {
  return path.join(app.getPath("userData"), "theo.json");
}

function load(): FileShape {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), "utf8")) as FileShape;
  } catch {
    cache = { settings: {}, secrets: {} };
  }
  cache.settings ??= {};
  cache.secrets ??= {};
  return cache;
}

function save(): void {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(load(), null, 2), { mode: 0o600 });
}

export function getSettings(): Settings {
  return { ...defaults, ...load().settings };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const data = load();
  data.settings = { ...data.settings, ...patch };
  save();
  return getSettings();
}

/** Secrets are encrypted with the macOS Keychain-backed key before touching disk. */
export function setSecret(name: SecretName, value: string): void {
  const data = load();
  if (!value) {
    delete data.secrets[name];
  } else if (safeStorage.isEncryptionAvailable()) {
    data.secrets[name] = `enc:${safeStorage.encryptString(value).toString("base64")}`;
  } else {
    throw new Error("Secure storage is unavailable, so the key was not saved");
  }
  save();
}

export function getSecret(name: SecretName): string {
  const stored = load().secrets[name];
  if (!stored?.startsWith("enc:")) return "";
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
  } catch {
    return "";
  }
}

export function hasSecret(name: SecretName): boolean {
  return Boolean(load().secrets[name]);
}
