import crypto from "crypto";

const MINIMAX_API = "https://api.minimax.io";
const MINIMAX_TTS_API = "https://api-uw.minimax.io";
const MINIMAX_TTS_MODEL = "speech-2.8-turbo";
const GROQ_TRANSCRIBE = "https://api.groq.com/openai/v1/audio/transcriptions";

interface MiniMaxBase {
  status_code?: number;
  status_msg?: string;
}

/** How sure Whisper was about one stretch of what it heard. */
interface WhisperSegment {
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
  temperature?: number;
}

async function whisper(
  audio: Buffer,
  mimeType: string,
  groqKey: string,
  format: "json" | "verbose_json",
  signal?: AbortSignal,
): Promise<{ text?: string; segments?: WhisperSegment[] }> {
  const form = new FormData();
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `speech.${extension}`);
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", format);
  form.append("temperature", "0");

  const response = await fetch(GROQ_TRANSCRIBE, {
    method: "POST",
    headers: { Authorization: `Bearer ${groqKey}` },
    body: form,
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Groq rejected the API key. Check it in Settings.");
    throw new Error(`Transcription failed (HTTP ${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as { text?: string; segments?: WhisperSegment[] };
}

/** Speech to text through Groq's hosted Whisper. */
export async function transcribe(
  audio: Buffer,
  mimeType: string,
  groqKey: string,
  signal?: AbortSignal,
): Promise<string> {
  return ((await whisper(audio, mimeType, groqKey, "json", signal)).text ?? "").trim();
}

/**
 * Speech to text for sound overheard while DesktopJarvis was idle, to check for the wake word.
 *
 * The wake word is deliberately not given to Whisper as a word to expect: told to expect
 * a name, it will hear that name in a cough or the clatter of a keyboard. Whisper also
 * writes words for noise, so this says when it was itself unsure, using the measures
 * Whisper uses to judge its own work (a stretch it thinks was silence, a guess it had to
 * retry, text that loops). `doubt` is empty when the words can be trusted.
 */
export async function transcribeOverheard(audio: Buffer, groqKey: string): Promise<{ text: string; doubt: string }> {
  const body = await whisper(audio, "audio/wav", groqKey, "verbose_json");
  const text = (body.text ?? "").trim();
  // The wake word has to come first, so it is in the first stretch.
  const first = body.segments?.[0];
  if (!first) return { text, doubt: "" };
  const noSpeech = first.no_speech_prob ?? 0;
  const confidence = first.avg_logprob ?? 0;
  let doubt = "";
  if (noSpeech > 0.8 || (noSpeech > 0.6 && confidence < -0.5)) doubt = "probably not speech";
  else if ((first.temperature ?? 0) > 0) doubt = "the recogniser had to guess";
  else if (confidence < -1.2) doubt = "unclear";
  else if ((first.compression_ratio ?? 0) > 2.4) doubt = "garbled";
  return { text, doubt };
}

/** Text to speech in the given MiniMax voice. Returns one MP3 buffer. */
export async function synthesize(
  text: string,
  voiceId: string,
  minimaxKey: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const response = await fetch(`${MINIMAX_TTS_API}/v1/t2a_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${minimaxKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MINIMAX_TTS_MODEL,
      text,
      stream: false,
      output_format: "hex",
      voice_setting: { voice_id: voiceId, speed: 1.05, vol: 1.0, pitch: 0 },
      language_boost: "auto",
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
    signal,
  });
  const raw = await response.text();
  let body: { data?: { audio?: string }; base_resp?: MiniMaxBase };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`MiniMax speech failed with HTTP ${response.status}`);
  }
  if (!response.ok || (body.base_resp?.status_code ?? 0) !== 0) {
    throw new Error(`MiniMax could not speak: ${body.base_resp?.status_msg ?? `HTTP ${response.status}`}`);
  }
  const hex = body.data?.audio;
  if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error("MiniMax returned no playable audio");
  }
  return Buffer.from(hex, "hex");
}

async function uploadForClone(audio: Buffer, filename: string, mimeType: string, minimaxKey: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "voice_clone");
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), filename);

  const response = await fetch(`${MINIMAX_API}/v1/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${minimaxKey}` },
    body: form,
  });
  // File IDs are int64. Quote them before JSON.parse so large IDs are not rounded.
  const raw = (await response.text()).replace(/("file_id"\s*:\s*)(\d+)/g, '$1"$2"');
  let body: { file?: { file_id?: string }; base_resp?: MiniMaxBase };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`MiniMax upload failed with HTTP ${response.status}`);
  }
  if (!response.ok || (body.base_resp?.status_code ?? 0) !== 0) {
    throw new Error(`MiniMax rejected the recording: ${body.base_resp?.status_msg ?? `HTTP ${response.status}`}`);
  }
  const fileId = body.file?.file_id;
  if (!fileId || !/^\d+$/.test(String(fileId))) {
    throw new Error("MiniMax did not return a file ID for the recording");
  }
  return String(fileId);
}

/** Clone a voice from a 10 second to 5 minute recording. Returns the new voice id. */
export async function cloneVoice(
  audio: Buffer,
  filename: string,
  mimeType: string,
  minimaxKey: string,
): Promise<string> {
  const fileId = await uploadForClone(audio, filename, mimeType, minimaxKey);
  // MiniMax requires 8+ characters, starting with a letter, containing a digit.
  const voiceId = `theo1_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

  // file_id is written as a bare integer literal to keep int64 precision.
  const payload = JSON.stringify({
    file_id: "__FILE_ID__",
    voice_id: voiceId,
    need_noise_reduction: true,
    need_volume_normalization: true,
  }).replace('"__FILE_ID__"', fileId);

  const response = await fetch(`${MINIMAX_API}/v1/voice_clone`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${minimaxKey}`,
      "Content-Type": "application/json",
    },
    body: payload,
  });
  let body: { input_sensitive?: boolean; base_resp?: MiniMaxBase };
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(`MiniMax voice cloning failed with HTTP ${response.status}`);
  }
  if (!response.ok || (body.base_resp?.status_code ?? 0) !== 0) {
    throw new Error(`MiniMax could not clone this voice: ${body.base_resp?.status_msg ?? `HTTP ${response.status}`}`);
  }
  if (body.input_sensitive) {
    throw new Error("MiniMax rejected the recording during its content safety check");
  }
  return voiceId;
}

/** Remove markup that a voice would otherwise read aloud. */
export function forSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// Words people say before a name to get attention. Anything else in front of the wake
// word means it came up in conversation rather than being said to DesktopJarvis.
const GREETINGS = new Set([
  "hey",
  "hi",
  "hello",
  "hiya",
  "ok",
  "okay",
  "oi",
  "yo",
  "um",
  "umm",
  "uh",
  "er",
  "erm",
  "ah",
  "oh",
  "good",
  "morning",
  "afternoon",
  "evening",
]);

/**
 * Look for the wake word at the start of what was heard: first, or after at most two
 * greetings ("Hey Jarvis", "Good morning Jarvis").
 * Returns the words after it ("" if nothing followed), or null when it was not said.
 */
export function afterWakeWord(heard: string, wakeWord: string): string | null {
  const letters = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const target = letters(wakeWord);
  if (!target) return null;
  // Stray punctuation ("...", "-") is not a word.
  const tokens = heard
    .trim()
    .split(/\s+/)
    .filter((token) => letters(token));
  const span = Math.max(1, wakeWord.trim().split(/\s+/).length);
  // Recognisers misspell names, so a wake word of 5+ letters may be one letter out (9+: two). Heard as more
  // or fewer words than it has ("Jar vis"), it has to be spelt exactly.
  let tolerance = 0;
  if (target.length >= 9) tolerance = 2;
  else if (target.length >= 5) tolerance = 1;
  for (let start = 0; start <= 2 && start < tokens.length; start += 1) {
    if (start > 0 && !GREETINGS.has(letters(tokens[start - 1]))) break;
    for (const width of [span, span + 1, span - 1]) {
      if (width < 1) continue;
      const candidate = letters(tokens.slice(start, start + width).join(""));
      if (candidate && editDistance(candidate, target) <= (width === span ? tolerance : 0)) {
        return tokens
          .slice(start + width)
          .join(" ")
          .replace(/^[\s,.!?:;-]+/, "");
      }
    }
  }
  return null;
}
