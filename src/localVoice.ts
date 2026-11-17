import { ChildProcess, execFile, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { app } from "electron";

/**
 * Theo's free voice: an open model (F5-TTS) that runs on this Mac and imitates a short
 * recording. It lives in its own Python environment under ~/.theo/voice, set up by
 * voice/setup.sh, and is started the first time it is needed.
 */

const HOME = path.join(os.homedir(), ".theo", "voice");
const PYTHON = path.join(HOME, "venv", "bin", "python");
const SAMPLE_RATE = 24_000;

let server: { process: ChildProcess; port: number; token: string } | null = null;
let starting: Promise<void> | null = null;

function serverScript(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "voice", "server.py")
    : path.join(app.getAppPath(), "voice", "server.py");
}

export function localVoiceInstalled(): boolean {
  return fs.existsSync(PYTHON);
}

/** Where the recording Theo imitates is kept. */
export function referencePath(): string {
  return path.join(app.getPath("userData"), "voice-reference.wav");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function start(): Promise<void> {
  if (!localVoiceInstalled()) {
    throw new Error("The free voice is not installed yet. Run voice/setup.sh from the Theo folder first.");
  }
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("hex");
  const child = spawn(PYTHON, [serverScript(), "--port", String(port)], {
    env: { ...process.env, THEO_VOICE_TOKEN: token, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let errors = "";
    // The first start downloads the model, which can take several minutes.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The free voice took too long to start"));
    }, 15 * 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-600);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (server?.process === child) server = null;
      reject(new Error(`The free voice stopped while starting: ${errors.trim().split("\n").pop() ?? "no details"}`));
    });
  });
  server = { process: child, port, token };
}

async function ready(): Promise<NonNullable<typeof server>> {
  if (!server) {
    starting ??= start().finally(() => {
      starting = null;
    });
    await starting;
  }
  if (!server) throw new Error("The free voice is not running");
  return server;
}

/** Speak one piece of text. Returns WAV audio. */
export async function speakLocally(
  text: string,
  cloned: { text: string } | null,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { port, token } = await ready();
  const response = await fetch(`http://127.0.0.1:${port}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Theo-Token": token },
    body: JSON.stringify({
      text,
      reference: cloned ? referencePath() : null,
      reference_text: cloned?.text ?? "",
    }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(`The free voice could not speak: ${body.error ?? `error ${response.status}`}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Start the voice in the background so it is loaded before it is first needed. */
export function warmLocalVoice(): void {
  if (localVoiceInstalled()) ready().catch(() => undefined);
}

export function stopLocalVoice(): void {
  server?.process.kill();
  server = null;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, _stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve()));
  });
}

/** Read 16-bit mono samples out of a WAV file. */
function readWav(file: Buffer): Int16Array {
  let offset = 12;
  while (offset + 8 <= file.length) {
    const id = file.toString("ascii", offset, offset + 4);
    const size = file.readUInt32LE(offset + 4);
    if (id === "data") {
      const end = Math.min(file.length, offset + 8 + size);
      const samples = new Int16Array(Math.floor((end - offset - 8) / 2));
      for (let i = 0; i < samples.length; i += 1) samples[i] = file.readInt16LE(offset + 8 + i * 2);
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("That recording could not be read");
}

function writeWav(samples: Int16Array): Buffer {
  const file = Buffer.alloc(44 + samples.length * 2);
  file.write("RIFF", 0);
  file.writeUInt32LE(36 + samples.length * 2, 4);
  file.write("WAVEfmt ", 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(SAMPLE_RATE, 24);
  file.writeUInt32LE(SAMPLE_RATE * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36);
  file.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => file.writeInt16LE(sample, 44 + i * 2));
  return file;
}

/** Loudness of each tenth of a second. */
function loudness(samples: Int16Array): number[] {
  const window = SAMPLE_RATE / 10;
  const levels: number[] = [];
  for (let start = 0; start + window <= samples.length; start += window) {
    let sum = 0;
    for (let i = start; i < start + window; i += 1) sum += samples[i] * samples[i];
    levels.push(Math.sqrt(sum / window));
  }
  return levels;
}

/**
 * Turn any recording into the short sample the model imitates: 24 kHz mono, silence
 * trimmed from the start, and cut at a pause somewhere between six and ten seconds in,
 * because the model works best from a short sample that ends cleanly.
 * Saves it as the reference and returns the same audio for transcription.
 */
export async function saveReference(audio: Buffer, filename: string): Promise<Buffer> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "theo-voice-"));
  try {
    const source = path.join(folder, `in${path.extname(filename) || ".wav"}`);
    const converted = path.join(folder, "out.wav");
    fs.writeFileSync(source, audio);
    // afconvert ships with macOS and reads WAV, MP3 and M4A.
    await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", source, converted]);
    const samples = readWav(fs.readFileSync(converted));
    const levels = loudness(samples);
    const peak = Math.max(...levels, 1);
    const first = levels.findIndex((level) => level > peak * 0.08);
    if (first < 0) throw new Error("The recording is silent");
    const start = Math.max(0, first - 1);
    const available = levels.length - start;
    if (available < 30) throw new Error("The free voice needs at least three seconds of speech");

    let length = Math.min(available, 100);
    if (available > 60) {
      // Find the quietest moment between six and ten seconds in, and stop there.
      let quietest = Infinity;
      for (let i = 60; i < Math.min(available, 100); i += 1) {
        if (levels[start + i] < quietest) {
          quietest = levels[start + i];
          length = i + 1;
        }
      }
    }
    const clip = samples.slice(start * (SAMPLE_RATE / 10), (start + length) * (SAMPLE_RATE / 10));
    const fade = Math.min(clip.length, SAMPLE_RATE / 20);
    for (let i = 0; i < fade; i += 1) clip[clip.length - 1 - i] = Math.round(clip[clip.length - 1 - i] * (i / fade));
    const file = writeWav(clip);
    fs.writeFileSync(referencePath(), file, { mode: 0o600 });
    return file;
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

export function removeReference(): void {
  fs.rmSync(referencePath(), { force: true });
}
