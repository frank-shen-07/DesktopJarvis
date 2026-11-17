import crypto from "crypto";
import fs from "fs";
import path from "path";
import { app } from "electron";

/**
 * The quick things DesktopJarvis says while it works: an acknowledgement the moment a request
 * is heard, and the name of the step it is on. They are short and repeat often, so the
 * audio for each is made once per voice and kept on disk, and plays without a wait.
 */

const QUESTION_ACKS = ["Let me check.", "Let me see.", "One sec."];
const COMMAND_ACKS = ["On it.", "Sure thing.", "Right away."];
const WAIT_ACKS = ["One sec.", "Give me a moment."];

/** Every acknowledgement, for preparing their audio ahead of time. */
export const ACKS = [...new Set([...QUESTION_ACKS, ...COMMAND_ACKS, ...WAIT_ACKS])];

// Words that mean DesktopJarvis will have to go and do something before it can answer.
const TASK =
  /\b(calendar|schedule|meetings?|events?|appointments?|remind|reminders?|e-?mails?|mail|inbox|messages?|send|draft|reply|open|launch|play|pause|search|look up|find|files?|documents?|word|excel|browser|page|website|notes?|add|create|set|book|weather|news|forecast|volume|check|summari[sz]e|what'?s on|to-?dos?|tasks?)\b/i;
const QUESTION =
  /^(what|whats|what's|when|where|who|which|how|is|are|do|does|did|can|could|any|have|has|will|would|am|should)\b|\?\s*$/i;

let lastAck = "";

function pick(pool: string[]): string {
  const choices = pool.filter((phrase) => phrase !== lastAck);
  lastAck = choices[Math.floor(Math.random() * choices.length)];
  return lastAck;
}

/**
 * The acknowledgement for a request. `instant` is true when the request plainly needs
 * work, so it is said at once; otherwise it is held back and said only if the answer
 * turns out to be slow, so "how are you" is not met with "let me check".
 */
export function chooseAck(heard: string): { text: string; instant: boolean } {
  const words = heard.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 2 && TASK.test(heard)) {
    return { text: pick(QUESTION.test(heard.trim()) ? QUESTION_ACKS : COMMAND_ACKS), instant: true };
  }
  return { text: pick(WAIT_ACKS), instant: false };
}

// ---------- Sentences out of a stream ----------

const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|No|approx|e\.g|i\.e)|\b[A-Z])\.$/;
// The first piece is released as soon as it is a few words long; later ones are
// gathered into fuller pieces, which sound more natural when spoken.
const FIRST_PIECE = 12;
const LATER_PIECE = 60;

export interface PieceSizes {
  /** The shortest first piece, in characters. */
  first?: number;
  /** The shortest piece after that. */
  later?: number;
}

/** Collects text as it is written and hands on whole sentences as soon as each is complete. */
export class SentenceStream {
  private buffer = "";
  private released = false;
  private readonly first: number;
  private readonly later: number;

  constructor(
    private readonly emit: (sentence: string) => void,
    sizes: PieceSizes = {},
  ) {
    this.first = sizes.first ?? FIRST_PIECE;
    this.later = sizes.later ?? LATER_PIECE;
  }

  push(text: string): void {
    this.buffer += text;
    for (;;) {
      const end = this.boundary();
      if (end < 0) return;
      this.release(end);
    }
  }

  /** Hand on whatever is left, complete or not. */
  flush(): void {
    this.release(this.buffer.length);
    this.released = false;
  }

  private release(end: number): void {
    const piece = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end);
    if (!piece) return;
    this.released = true;
    this.emit(piece);
  }

  /** Where the next piece ends, or -1 if it is not complete yet. */
  private boundary(): number {
    const least = this.released ? this.later : this.first;
    const ends = /[.!?…]+["'”’)\]]*\s+|\n+/g;
    for (let match = ends.exec(this.buffer); match; match = ends.exec(this.buffer)) {
      const end = match.index + match[0].length;
      if (end < least) continue;
      const before = this.buffer.slice(0, match.index + match[0].trimEnd().length);
      // "Dr. Shah" and "3. Then" are not ends of sentences.
      if (ABBREVIATION.test(before) || /\b\d+\.$/.test(before)) continue;
      return end;
    }
    return -1;
  }
}

/** Text already written in full, cut into the pieces it is spoken in. */
export function sentencesOf(text: string, sizes: PieceSizes = {}): string[] {
  const pieces: string[] = [];
  const stream = new SentenceStream((piece) => pieces.push(piece), sizes);
  stream.push(text);
  stream.flush();
  return pieces;
}

// ---------- Audio kept per voice ----------

const memory = new Map<string, Buffer>();
const making = new Map<string, Promise<Buffer>>();

const digest = (text: string) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 20);
const root = () => path.join(app.getPath("userData"), "phrases");
const fileFor = (voice: string, text: string) => path.join(root(), digest(voice), `${digest(text)}.audio`);

/** The audio for `text` in `voice`, made with `make` the first time and kept after that. */
export function keptPhrase(voice: string, text: string, make: () => Promise<Buffer>): Promise<Buffer> {
  const file = fileFor(voice, text);
  const held = memory.get(file);
  if (held) return Promise.resolve(held);
  const pending = making.get(file);
  if (pending) return pending;
  const job = (async () => {
    try {
      const saved = await fs.promises.readFile(file);
      if (saved.length) {
        memory.set(file, saved);
        return saved;
      }
    } catch {
      // Not made yet.
    }
    const audio = await make();
    memory.set(file, audio);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, audio, { mode: 0o600 });
    } catch {
      // Without the file it is simply made again next time DesktopJarvis starts.
    }
    return audio;
  })().finally(() => making.delete(file));
  making.set(file, job);
  return job;
}

let warming = "";

/**
 * Make the acknowledgements for this voice now, one at a time, so the first request
 * does not wait for them. Audio kept for voices no longer in use is removed.
 */
export async function preparePhrases(voice: string, make: (text: string) => Promise<Buffer>): Promise<void> {
  if (warming === voice) return;
  warming = voice;
  try {
    const keep = digest(voice);
    for (const entry of await fs.promises.readdir(root()).catch(() => [] as string[])) {
      if (entry !== keep) await fs.promises.rm(path.join(root(), entry), { recursive: true, force: true });
    }
    for (const phrase of ACKS) {
      if (warming !== voice) return;
      await keptPhrase(voice, phrase, () => make(phrase));
    }
  } catch {
    // A voice that cannot speak right now is reported when it is next used.
  } finally {
    if (warming === voice) warming = "";
  }
}
