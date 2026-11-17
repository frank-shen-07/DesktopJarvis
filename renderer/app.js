"use strict";

(() => {
// `theo` is the bridge the preload script exposes on window.
const theo = window.theo;
const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) node.append(child);
  return node;
};

let state = null;

// ---------------------------------------------------------------- Navigation

function showView(name) {
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== `view-${name}`;
  for (const item of document.querySelectorAll(".dock-item")) {
    if (item.dataset.view === name) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

for (const item of document.querySelectorAll(".dock-item")) {
  item.addEventListener("click", () => showView(item.dataset.view));
}

function openLink(url) {
  theo.invoke("open:external", url).catch(() => undefined);
}

function setMessage(node, text, tone = "") {
  node.textContent = text;
  node.dataset.tone = tone;
}

function cleanError(error) {
  return String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// ---------------------------------------------------------------- Audio graph

let audioContext = null;
let micAnalyser = null;
let outAnalyser = null;
const player = new Audio();

function ensureAudio() {
  if (audioContext) return;
  audioContext = new AudioContext();
  micAnalyser = audioContext.createAnalyser();
  micAnalyser.fftSize = 1024;
  outAnalyser = audioContext.createAnalyser();
  outAnalyser.fftSize = 1024;
  audioContext.createMediaElementSource(player).connect(outAnalyser);
  outAnalyser.connect(audioContext.destination);
}

// ---------------------------------------------------------------- Core

const canvas = $("#core");
const pen = canvas.getContext("2d");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const spectrum = new Uint8Array(512);
const AMBER = "#ff9c2e";
const TAU = Math.PI * 2;
const BARS = 96;
const barLevels = new Float32Array(BARS);
let lastFrame = 0;
let coreSize = 0;

/** The core: the dragon, with a ring of bars that follows the live audio. */
function drawCore(time) {
  const ratio = devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  if (!width || !height) {
    // The Talk view is hidden; nothing to draw.
    requestAnimationFrame(drawCore);
    return;
  }
  const R = Math.max(40, (Math.min(width, height) / 2 - 10) * 0.74);
  if (Math.abs(coreSize - R) > 0.5) {
    coreSize = R;
    canvas.parentElement.style.setProperty("--core", `${Math.round(R * 0.74)}px`);
  }

  const elapsed = Math.min(64, time - lastFrame);
  lastFrame = time;

  const analyser =
    phase === "listening" ? micAnalyser : phase === "speaking" && !usingSystemVoice ? outAnalyser : null;
  if (analyser) analyser.getByteFrequencyData(spectrum);
  const live = phase === "listening" ? "#fff6e0" : "#ffd27a";
  const drift = reducedMotion.matches ? 0 : time;

  pen.setTransform(ratio, 0, 0, ratio, 0, 0);
  pen.clearRect(0, 0, width, height);
  pen.save();
  pen.translate(width / 2, height / 2);
  // The dragon reacts to what Theo is doing.
  let loudness = 0;
  if (analyser) {
    for (let i = 3; i < 99; i += 1) loudness += spectrum[i];
    loudness /= 96 * 255;
  }
  theoDragon.draw(pen, {
    R,
    time: drift,
    elapsed,
    still: reducedMotion.matches,
    phase,
    loudness,
    voiced: Boolean(analyser),
  });
  pen.lineCap = "butt";

  // Sound: a ring of bars round the centre while Theo is listening, working or speaking.
  const inner = R * 0.44;
  const reach = R * 0.2;
  pen.shadowColor = AMBER;
  pen.shadowBlur = analyser ? 8 : 0;
  pen.lineWidth = 2;
  pen.strokeStyle = analyser ? live : AMBER;
  for (let i = 0; i < BARS; i += 1) {
    const mirrored = i < BARS / 2 ? i : BARS - 1 - i;
    let target = 0;
    if (analyser) target = spectrum[3 + mirrored * 2] / 255;
    else if (phase !== "idle") target = 0.3 + 0.28 * Math.sin(mirrored * 0.55 - drift / 170);
    barLevels[i] += (target - barLevels[i]) * 0.35;
    if (barLevels[i] < 0.02) continue;
    const length = reach * barLevels[i];
    const angle = (i / BARS) * TAU - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    pen.beginPath();
    pen.moveTo(cos * inner, sin * inner);
    pen.lineTo(cos * (inner + length), sin * (inner + length));
    pen.stroke();
  }

  pen.restore();
  requestAnimationFrame(drawCore);
}

// ---------------------------------------------------------------- Talk state

const talkButton = $("#talk-button");
const phaseLabel = $("#phase");
const transcript = $("#transcript");
const IDLE_HINT = "Hold space, or click the core to talk";
const coreState = $("#core-state");

let phase = "idle"; // idle | listening | working | speaking
let currentTurn = null; // { id, node, steps, failed }
let pendingTurnNode = null;
let playQueue = [];
let playing = false;
let turnFinished = true;
let usingSystemVoice = false;
let lastTurnOk = false;

function setPhase(next, label) {
  phase = next;
  talkButton.dataset.phase = next;
  talkButton.setAttribute(
    "aria-label",
    { idle: "Talk to Theo", listening: "Stop and send", working: "Cancel", speaking: "Stop speaking" }[next],
  );
  coreState.textContent = { idle: "Standby", listening: "Listening", working: "Working", speaking: "Speaking" }[next];
  if (next === "idle" && !label && wakeActive()) label = `Say “${state.settings.wakeWord}”, or click the core`;
  phaseLabel.textContent =
    label ?? { idle: IDLE_HINT, listening: "Listening", working: "Thinking", speaking: "Click the core to stop" }[next];
}

function newTurnNode() {
  $("#talk-empty")?.remove();
  const node = el("article", { className: "turn" });
  transcript.append(node);
  node.scrollIntoView({ block: "end" });
  return node;
}

function scrollDown() {
  transcript.scrollTop = transcript.scrollHeight;
}

function stopSpeaking() {
  playQueue.forEach((url) => URL.revokeObjectURL(url));
  playQueue = [];
  playing = false;
  player.pause();
  speechSynthesis.cancel();
  usingSystemVoice = false;
}

function settleIfDone() {
  if (!turnFinished || playing || playQueue.length || speechSynthesis.speaking) return;
  if (phase === "listening") return;
  usingSystemVoice = false;
  setPhase("idle");
  if (state?.settings.keepListening && lastTurnOk) startListening({ auto: true });
}

function playNext() {
  if (playing) return;
  const url = playQueue.shift();
  if (!url) {
    settleIfDone();
    return;
  }
  playing = true;
  setPhase("speaking");
  player.src = url;
  player.play().catch(() => {
    playing = false;
    playNext();
  });
}

player.addEventListener("ended", () => {
  URL.revokeObjectURL(player.src);
  playing = false;
  playNext();
});

theo.on("turn", (event) => {
  if (!currentTurn || currentTurn.id !== event.turnId) {
    currentTurn = { id: event.turnId, node: pendingTurnNode ?? newTurnNode(), steps: null };
    pendingTurnNode = null;
    turnFinished = false;
    lastTurnOk = false;
  }
  const turn = currentTurn;

  switch (event.type) {
    case "status":
      setPhase("working", event.status === "transcribing" ? "Working out what you said" : "Thinking");
      break;
    case "heard":
      if (!$(".heard", turn.node)) turn.node.append(el("p", { className: "heard", textContent: event.text }));
      break;
    case "tool": {
      turn.steps ??= turn.node.appendChild(el("ul", { className: "steps" }));
      let step = turn.steps.querySelector(`[data-id="${CSS.escape(event.id)}"]`);
      if (!step) {
        step = el("li", { className: "step", textContent: event.label });
        step.dataset.id = event.id;
        turn.steps.append(step);
      }
      step.dataset.state = event.state;
      if (event.state === "running") setPhase("working", event.label);
      break;
    }
    case "reply":
      turn.node.append(el("p", { className: "reply", textContent: event.text }));
      lastTurnOk = true;
      break;
    case "audio":
      ensureAudio();
      playQueue.push(speechUrl(event.audio));
      playNext();
      break;
    case "system-voice": {
      usingSystemVoice = true;
      setPhase("speaking");
      const utterance = new SpeechSynthesisUtterance(event.text);
      utterance.onend = utterance.onerror = () => settleIfDone();
      speechSynthesis.speak(utterance);
      break;
    }
    case "notice":
      turn.node.append(el("p", { className: "turn-notice", textContent: event.message }));
      break;
    case "error":
      turn.node.append(el("p", { className: "turn-error", textContent: event.message }));
      break;
    case "done":
      turnFinished = true;
      if (event.empty) {
        turn.node.append(el("p", { className: "turn-notice", textContent: "Theo didn’t catch anything. Try again a little closer to the microphone." }));
      }
      if (!turn.node.childElementCount) turn.node.remove();
      hideConfirm();
      settleIfDone();
      break;
  }
  scrollDown();
});

// ---------------------------------------------------------------- Listening

let recorder = null;
let micStream = null;
let micSource = null;
let vadTimer = null;
let discardRecording = false;

function releaseMic() {
  clearInterval(vadTimer);
  vadTimer = null;
  micSource?.disconnect();
  micSource = null;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  recorder = null;
}

async function startListening({ auto }) {
  if (phase === "listening" || recorder) return;
  stopSpeaking();
  if (phase !== "idle") await theo.invoke("talk:cancel");
  ensureAudio();
  await audioContext.resume();

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    const node = newTurnNode();
    const fix = el("button", { className: "linkish", textContent: "Open microphone settings" });
    fix.addEventListener("click", () => openLink("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"));
    node.append(el("p", { className: "turn-error", textContent: "Theo can’t use the microphone. Allow it in System Settings, then try again. " }, fix));
    setPhase("idle");
    return;
  }

  micSource = audioContext.createMediaStreamSource(micStream);
  micSource.connect(micAnalyser);
  const chunks = [];
  discardRecording = false;
  recorder = new MediaRecorder(micStream, { mimeType: "audio/webm;codecs=opus" });
  recorder.addEventListener("dataavailable", (event) => event.data.size && chunks.push(event.data));
  recorder.addEventListener("stop", async () => {
    const mimeType = recorder?.mimeType ?? "audio/webm";
    releaseMic();
    if (discardRecording) {
      setPhase("idle");
      return;
    }
    const audio = await new Blob(chunks, { type: mimeType }).arrayBuffer();
    if (audio.byteLength < 2000) {
      setPhase("idle");
      return;
    }
    pendingTurnNode = newTurnNode();
    setPhase("working", "Working out what you said");
    theo.invoke("talk:audio", audio, "audio/webm");
  });
  recorder.start();
  if (!auto && !spaceHeld) {
    stopListening(false);
    return;
  }
  setPhase("listening", auto ? "Listening. Theo sends it when you pause." : "Listening. Let go to send.");

  if (!auto) return;
  // Tap-to-talk: send after a pause, give up if nothing is said.
  const startedAt = performance.now();
  let spokeAt = 0;
  let quietSince = 0;
  const level = new Float32Array(micAnalyser.fftSize);
  vadTimer = setInterval(() => {
    micAnalyser.getFloatTimeDomainData(level);
    let sum = 0;
    for (const value of level) sum += value * value;
    const loud = Math.sqrt(sum / level.length) > 0.018;
    const now = performance.now();
    if (loud) {
      spokeAt ||= now;
      quietSince = 0;
    } else if (spokeAt) {
      quietSince ||= now;
      if (now - quietSince > 1300) stopListening(true);
    } else if (now - startedAt > 7000) {
      stopListening(false);
    }
    if (now - startedAt > 60_000) stopListening(Boolean(spokeAt));
  }, 80);
}

function stopListening(send) {
  if (!recorder || recorder.state === "inactive") return;
  clearInterval(vadTimer);
  discardRecording = !send;
  recorder.stop();
}

async function cancelEverything() {
  stopSpeaking();
  stopListening(false);
  turnFinished = true;
  lastTurnOk = false;
  hideConfirm();
  for (const node of [pendingTurnNode, currentTurn?.node]) {
    if (node && !node.childElementCount) node.remove();
  }
  pendingTurnNode = null;
  await theo.invoke("talk:cancel");
  setPhase("idle");
}

talkButton.addEventListener("click", () => {
  if (phase === "idle") startListening({ auto: true });
  else if (phase === "listening") stopListening(true);
  else cancelEverything();
});

theo.on("shortcut:talk", () => {
  showView("talk");
  if (phase === "listening") stopListening(true);
  else startListening({ auto: true });
});

// Hold space to talk, release to send.
let spaceHeld = false;
const typingTarget = (target) => target instanceof HTMLElement && target.matches("input, textarea, select");

addEventListener("keydown", (event) => {
  if (event.code !== "Space" || typingTarget(event.target) || $("#view-talk").hidden) return;
  event.preventDefault();
  if (event.repeat || spaceHeld) return;
  spaceHeld = true;
  startListening({ auto: false });
});

addEventListener("keyup", (event) => {
  if (event.code !== "Space" || !spaceHeld) return;
  event.preventDefault();
  spaceHeld = false;
  // Releasing before the microphone opened leaves nothing to send.
  if (recorder) stopListening(true);
});

addEventListener("keydown", (event) => {
  if (event.key === "Escape" && phase !== "idle") cancelEverything();
});

$("#type-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#type-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  stopSpeaking();
  stopListening(false);
  pendingTurnNode = newTurnNode();
  setPhase("working");
  theo.invoke("talk:text", text);
});

// ---------------------------------------------------------------- Wake word

// While idle, the microphone stays open. Each stretch of speech is captured with
// a little lead-in and sent for checking; only speech that starts with the wake
// word goes any further.
let wakeStream = null;
let wakeNode = null;
let wakeSource = null;
let wakeLead = [];
let wakeSpeech = null;
let wakeQuiet = 0;
let wakeVoiced = 0;

function wakeActive() {
  return Boolean(state?.settings.wakeEnabled && state.keys.groq && state.settings.wakeWord.trim());
}

function chime() {
  const tone = audioContext.createOscillator();
  const gain = audioContext.createGain();
  tone.frequency.value = 880;
  gain.gain.setValueAtTime(0.12, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.18);
  tone.connect(gain).connect(audioContext.destination);
  tone.start();
  tone.stop(audioContext.currentTime + 0.2);
}

async function checkWakeSpeech(chunks) {
  // Whisper works at 16 kHz, so average the samples down before sending.
  const step = Math.max(1, Math.round(audioContext.sampleRate / 16000));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  const small = new Float32Array(Math.floor(total / step));
  for (let i = 0; i < small.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < step; j += 1) sum += joined[i * step + j];
    small[i] = sum / step;
  }
  const result = await theo.invoke("wake:audio", encodeWav(small, audioContext.sampleRate / step));
  if (result.error && phase === "idle") phaseLabel.textContent = result.error;
  if (!result.matched || phase !== "idle") return;
  showView("talk");
  if (!result.command) {
    chime();
    startListening({ auto: true });
  }
}

function onWakeAudio(event) {
  if (phase !== "idle") {
    // Theo is busy or speaking; ignore the room until it is idle again.
    wakeSpeech = null;
    wakeLead = [];
    return;
  }
  const frame = new Float32Array(event.inputBuffer.getChannelData(0));
  let sum = 0;
  for (const value of frame) sum += value * value;
  const loud = Math.sqrt(sum / frame.length) > 0.02;
  const frameMs = (frame.length / audioContext.sampleRate) * 1000;

  if (!wakeSpeech) {
    wakeLead.push(frame);
    if (wakeLead.length > 6) wakeLead.shift();
    if (!loud) return;
    wakeSpeech = wakeLead;
    wakeLead = [];
    wakeQuiet = 0;
    wakeVoiced = frameMs;
    return;
  }
  wakeSpeech.push(frame);
  if (loud) {
    wakeVoiced += frameMs;
    wakeQuiet = 0;
  } else {
    wakeQuiet += frameMs;
  }
  const lengthMs = wakeSpeech.length * frameMs;
  if (wakeQuiet < 900 && lengthMs < 15000) return;
  const finished = wakeSpeech;
  wakeSpeech = null;
  // Clicks and bumps are too short to be a wake word.
  if (wakeVoiced >= 250) checkWakeSpeech(finished).catch(() => undefined);
}

async function syncWakeListener() {
  const wanted = wakeActive();
  if (wanted && !wakeStream) {
    ensureAudio();
    try {
      wakeStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setMessage($("#wake-hint"), "Theo can’t use the microphone. Allow it in System Settings › Privacy & Security › Microphone.", "bad");
      return;
    }
    await audioContext.resume();
    wakeSource = audioContext.createMediaStreamSource(wakeStream);
    wakeNode = audioContext.createScriptProcessor(4096, 1, 1);
    wakeNode.onaudioprocess = onWakeAudio;
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    wakeSource.connect(wakeNode);
    wakeNode.connect(silent).connect(audioContext.destination);
  } else if (!wanted && wakeStream) {
    wakeNode.onaudioprocess = null;
    wakeSource.disconnect();
    wakeNode.disconnect();
    wakeStream.getTracks().forEach((track) => track.stop());
    wakeStream = wakeNode = wakeSource = wakeSpeech = null;
    wakeLead = [];
  }
}

// ---------------------------------------------------------------- Approvals

let confirmId = null;

function hideConfirm() {
  $("#confirm").hidden = true;
  confirmId = null;
}

function answerConfirm(approved) {
  if (!confirmId) return;
  theo.invoke("confirm:respond", confirmId, approved);
  hideConfirm();
}

theo.on("confirm:request", (request) => {
  showView("talk");
  confirmId = request.id;
  $("#confirm-title").textContent = request.title;
  $("#confirm-detail").textContent = request.detail;
  $("#confirm-yes").textContent = request.action;
  $("#confirm").hidden = false;
  setPhase("working", "Waiting for your answer");
  $("#confirm-yes").focus();
});

$("#confirm-yes").addEventListener("click", () => answerConfirm(true));
$("#confirm-no").addEventListener("click", () => answerConfirm(false));

// ---------------------------------------------------------------- Connections

const CONNECTIONS = {
  gmail: {
    name: "Gmail",
    about: "Read your inbox, draft replies, and send email after you approve each one.",
    setup: {
      steps: [
        "Open Google Cloud credentials and create a project.",
        "Enable the Gmail API for that project.",
        "Set up the OAuth consent screen as External and add your own address as a test user.",
        "Create an OAuth client ID of type Desktop app, then paste its ID and secret here.",
      ],
      link: ["Open Google Cloud credentials", "https://console.cloud.google.com/apis/credentials"],
      fields: [
        { key: "googleClientId", label: "Client ID", kind: "setting" },
        { key: "googleClientSecret", label: "Client secret", kind: "secret" },
      ],
    },
  },
  outlook: {
    name: "Outlook",
    about: "Read your inbox, draft replies, and send email after you approve each one.",
    setup: {
      steps: [
        "Open Microsoft Entra app registrations and choose New registration.",
        "For supported accounts, pick any organizational directory and personal Microsoft accounts.",
        "Add a redirect URI on the platform “Public client/native (mobile & desktop)” with the value http://localhost",
        "Paste the Application (client) ID here.",
      ],
      link: ["Open Microsoft Entra", "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"],
      fields: [{ key: "microsoftClientId", label: "Application (client) ID", kind: "setting" }],
    },
  },
  calendar: {
    name: "Mac Calendar",
    about: "Read your schedule and add events, across every account in the Calendar app.",
    settingsLink: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  },
  reminders: {
    name: "Reminders",
    about: "Create reminders that alert you at the time you ask for, and read what’s still open.",
    settingsLink: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
  },
  word: {
    name: "Microsoft Word",
    about: "Start new documents and open existing ones by name.",
    settingsLink: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  },
};

/** Text typed into a field but not saved yet, so a re-render does not wipe it. */
function readDrafts(rows) {
  const drafts = new Map();
  for (const input of rows.querySelectorAll("input[data-key]")) {
    if (input.value !== input.dataset.initial) drafts.set(input.dataset.key, input.value);
  }
  return drafts;
}

function draftInput(drafts, key, props) {
  const input = el("input", { spellcheck: false, ...props });
  input.dataset.key = key;
  input.dataset.initial = props.value ?? "";
  if (drafts.has(key)) input.value = drafts.get(key);
  return input;
}

const openSetups = new Set();
const connectionErrors = new Map();
const busyConnections = new Set();

async function connect(id) {
  busyConnections.add(id);
  connectionErrors.delete(id);
  renderConnections();
  try {
    applyState(await theo.invoke("connection:connect", id));
    openSetups.delete(id);
  } catch (error) {
    connectionErrors.set(id, cleanError(error));
  }
  busyConnections.delete(id);
  renderConnections();
}

function renderConnections() {
  const rows = $("#connection-rows");
  const drafts = readDrafts(rows);
  rows.replaceChildren();
  for (const connection of state.connections) {
    const info = CONNECTIONS[connection.id];
    const badgeText = { connected: "Connected", available: "Not connected", blocked: "Blocked" }[connection.status];
    const badge = el("span", { className: "badge", textContent: connection.detail ? `${badgeText} as ${connection.detail}` : badgeText });
    badge.dataset.status = connection.status;
    if (connection.status === "blocked") badge.textContent = "Blocked in System Settings";

    const actions = el("div", { className: "row-actions" });
    const busy = busyConnections.has(connection.id);
    const needsSetup =
      info.setup &&
      info.setup.fields.some((field) => (field.kind === "secret" ? !state.keys[field.key] : !state.settings[field.key]));

    if (connection.status === "connected") {
      if (connection.id === "gmail" || connection.id === "outlook") {
        const off = el("button", { className: "button quiet", textContent: "Disconnect" });
        off.addEventListener("click", async () => applyState(await theo.invoke("connection:disconnect", connection.id)));
        actions.append(off);
      }
    } else if (connection.status === "blocked") {
      const fix = el("button", { className: "button", textContent: "Open System Settings" });
      fix.addEventListener("click", () => openLink(info.settingsLink));
      actions.append(fix);
    } else {
      if (info.setup) {
        const toggle = el("button", { className: "button quiet", textContent: openSetups.has(connection.id) ? "Hide setup" : "Set up" });
        toggle.addEventListener("click", () => {
          if (!openSetups.delete(connection.id)) openSetups.add(connection.id);
          renderConnections();
        });
        actions.append(toggle);
      }
      const go = el("button", {
        className: "button primary",
        textContent: busy ? (info.setup ? "Waiting for your browser" : "Waiting for macOS") : `Connect ${info.name}`,
        disabled: busy || Boolean(needsSetup),
      });
      go.addEventListener("click", () => connect(connection.id));
      actions.append(go);
    }

    const row = el("div", { className: "row" }, [
      el("div", { className: "row-name" }, [info.name, badge]),
      actions,
      el("p", { className: "row-about", textContent: info.about }),
    ]);

    if (info.setup && connection.status !== "connected" && (openSetups.has(connection.id) || needsSetup)) {
      const extra = el("div", { className: "row-extra" });
      extra.append(el("ol", {}, info.setup.steps.map((step) => el("li", { textContent: step }))));
      const link = el("button", { className: "linkish", textContent: info.setup.link[0] });
      link.style.justifySelf = "start";
      link.addEventListener("click", () => openLink(info.setup.link[1]));
      extra.append(link);
      for (const field of info.setup.fields) {
        const saved = field.kind === "secret" ? state.keys[field.key] : Boolean(state.settings[field.key]);
        const input = draftInput(drafts, field.key, {
          type: field.kind === "secret" ? "password" : "text",
          value: field.kind === "setting" ? state.settings[field.key] : "",
          placeholder: saved && field.kind === "secret" ? "Saved. Paste a new one to replace it." : "",
        });
        input.setAttribute("aria-label", field.label);
        const save = el("button", { className: "button", textContent: `Save ${field.label.toLowerCase()}` });
        save.addEventListener("click", async () => {
          const value = input.value.trim();
          if (!value) return;
          input.value = input.dataset.initial;
          applyState(
            field.kind === "secret"
              ? await theo.invoke("secret:set", field.key, value)
              : await theo.invoke("settings:update", { [field.key]: value }),
          );
        });
        extra.append(el("div", { className: "field" }, [el("label", { textContent: field.label }), el("div", { className: "inline" }, [input, save])]));
      }
      row.append(extra);
    }

    const error = connectionErrors.get(connection.id);
    if (error) row.append(el("p", { className: "row-error", textContent: error }));
    rows.append(row);
  }
}

// ---------------------------------------------------------------- Voice

let sampleRecorder = null;
let sampleTimer = null;
let voiceSample = null; // { audio: ArrayBuffer, filename, mimeType }

function encodeWav(channel, sampleRate) {
  const buffer = { sampleRate };
  const view = new DataView(new ArrayBuffer(44 + channel.length * 2));
  const writeText = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  writeText(0, "RIFF");
  view.setUint32(4, 36 + channel.length * 2, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, channel.length * 2, true);
  for (let i = 0; i < channel.length; i += 1) {
    const value = Math.max(-1, Math.min(1, channel[i]));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return view.buffer;
}

function refreshCloneButton() {
  $("#clone-button").disabled = !(voiceSample && $("#voice-consent").checked);
}

const formatTime = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

$("#record-button").addEventListener("click", async () => {
  const button = $("#record-button");
  if (sampleRecorder) {
    sampleRecorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true } });
  } catch {
    setMessage($("#voice-message"), "Theo can’t use the microphone. Allow it in System Settings › Privacy & Security › Microphone.", "bad");
    return;
  }
  ensureAudio();
  const chunks = [];
  const startedAt = performance.now();
  sampleRecorder = new MediaRecorder(stream);
  sampleRecorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
  sampleRecorder.addEventListener("stop", async () => {
    clearInterval(sampleTimer);
    stream.getTracks().forEach((track) => track.stop());
    sampleRecorder = null;
    button.dataset.recording = "false";
    button.textContent = "Record again";
    const seconds = (performance.now() - startedAt) / 1000;
    if (seconds < 10) {
      voiceSample = null;
      setMessage($("#voice-message"), "That was under ten seconds. Record a longer take.", "bad");
    } else {
      const decoded = await audioContext.decodeAudioData(await new Blob(chunks).arrayBuffer());
      voiceSample = { audio: encodeWav(decoded.getChannelData(0), decoded.sampleRate), filename: "voice-sample.wav", mimeType: "audio/wav" };
      setMessage($("#voice-message"), `Recorded ${formatTime(seconds)}. Ready to create your voice.`);
    }
    refreshCloneButton();
  });
  sampleRecorder.start();
  button.dataset.recording = "true";
  button.textContent = "Stop recording";
  setMessage($("#voice-message"), "");
  sampleTimer = setInterval(() => {
    const seconds = (performance.now() - startedAt) / 1000;
    $("#record-time").textContent = formatTime(seconds);
    if (seconds >= 290) sampleRecorder?.stop();
  }, 250);
});

$("#voice-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    setMessage($("#voice-message"), "That file is larger than 20 MB. Choose a shorter recording.", "bad");
    return;
  }
  const extension = file.name.split(".").pop().toLowerCase();
  const mimeType = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" }[extension];
  if (!mimeType) {
    setMessage($("#voice-message"), "Choose an MP3, M4A or WAV file.", "bad");
    return;
  }
  voiceSample = { audio: await file.arrayBuffer(), filename: file.name, mimeType };
  $("#record-time").textContent = "";
  setMessage($("#voice-message"), `Using ${file.name}. Ready to create your voice.`);
  refreshCloneButton();
});

$("#voice-consent").addEventListener("change", refreshCloneButton);

/** Speech arrives as MP3 from MiniMax and as WAV from the free voice. */
function speechUrl(bytes) {
  const head = new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, 4);
  const wav = String.fromCharCode(...head) === "RIFF";
  return URL.createObjectURL(new Blob([bytes], { type: wav ? "audio/wav" : "audio/mpeg" }));
}

async function playBytes(bytes) {
  ensureAudio();
  await audioContext.resume();
  stopSpeaking();
  playQueue.push(speechUrl(bytes));
  playNext();
}

$("#clone-button").addEventListener("click", async () => {
  const button = $("#clone-button");
  button.disabled = true;
  setMessage($("#voice-message"), "Creating your voice. This takes up to a minute.");
  try {
    const result = await theo.invoke("voice:clone", { ...voiceSample, consent: $("#voice-consent").checked });
    applyState(result.state);
    voiceSample = null;
    setMessage($("#voice-message"), "Done. Theo now speaks in this voice.", "good");
    await playBytes(result.sample);
  } catch (error) {
    setMessage($("#voice-message"), cleanError(error), "bad");
  }
  refreshCloneButton();
});

$("#preview-button").addEventListener("click", async () => {
  try {
    await playBytes(await theo.invoke("voice:preview"));
  } catch (error) {
    setMessage($("#voice-message"), cleanError(error), "bad");
  }
});

$("#remove-voice").addEventListener("click", async () => applyState(await theo.invoke("voice:remove")));
$("#local-voice").addEventListener("change", async (event) =>
  applyState(await theo.invoke("settings:update", { localVoice: event.target.checked })));

// ---------------------------------------------------------------- Settings

const KEYS = [
  {
    id: "anthropic",
    name: "Anthropic",
    about: "Claude does the thinking and decides what to do on your Mac. Needed when Claude is chosen below.",
    link: "https://platform.claude.com/settings/keys",
  },
  {
    id: "groq",
    name: "Groq",
    about: "Turns what you say into text, and can do the thinking too. Free to start.",
    link: "https://console.groq.com/keys",
  },
  {
    id: "minimax",
    name: "MiniMax",
    about: "Clones your voice and speaks in it. Without it Theo uses your Mac’s built-in voice.",
    link: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
];

function renderKeys() {
  const rows = $("#key-rows");
  const drafts = readDrafts(rows);
  rows.replaceChildren();
  for (const key of KEYS) {
    const saved = state.keys[key.id];
    const badge = el("span", { className: "badge", textContent: saved ? "Saved" : "Not added" });
    badge.dataset.status = saved ? "connected" : "available";
    const input = draftInput(drafts, key.id, { type: "password", value: "", placeholder: saved ? "Paste a new key to replace it" : "Paste your key" });
    input.setAttribute("aria-label", `${key.name} API key`);
    const save = el("button", { className: "button", textContent: "Save key" });
    const store = async () => {
      const value = input.value.trim();
      if (!value) return;
      input.value = "";
      applyState(await theo.invoke("secret:set", key.id, value));
    };
    save.addEventListener("click", store);
    input.addEventListener("keydown", (event) => event.key === "Enter" && store());
    const get = el("button", { className: "linkish", textContent: `Get ${/^[AEIOU]/.test(key.name) ? "an" : "a"} ${key.name} key` });
    get.addEventListener("click", () => openLink(key.link));
    rows.append(
      el("div", { className: "row" }, [
        el("div", { className: "row-name" }, [key.name, badge]),
        el("div", { className: "row-actions" }, get),
        el("p", { className: "row-about", textContent: key.about }),
        el("div", { className: "row-extra" }, el("div", { className: "inline" }, [input, save])),
      ]),
    );
  }
}

$("#shortcut-save").addEventListener("click", async () => {
  const wanted = $("#shortcut").value.trim();
  applyState(await theo.invoke("settings:update", { shortcut: wanted }));
  if (!wanted) setMessage($("#shortcut-message"), "Shortcut turned off.");
  else if (state.shortcutActive) setMessage($("#shortcut-message"), "Saved.", "good");
  else setMessage($("#shortcut-message"), "macOS would not register that shortcut. Another app may be using it.", "bad");
});

$("#wake-enabled").addEventListener("change", async (event) =>
  applyState(await theo.invoke("settings:update", { wakeEnabled: event.target.checked })));
$("#keep-listening").addEventListener("change", async (event) =>
  applyState(await theo.invoke("settings:update", { keepListening: event.target.checked })));
$("#confirm-scripts").addEventListener("change", async (event) =>
  applyState(await theo.invoke("settings:update", { confirmScripts: event.target.checked })));
$("#model").addEventListener("change", async (event) =>
  applyState(await theo.invoke("settings:update", { model: event.target.value })));
$("#provider").addEventListener("change", async (event) =>
  applyState(await theo.invoke("settings:update", { provider: event.target.value })));
$("#agent-tools").addEventListener("change", async (event) =>
  applyState(await theo.invoke("settings:update", { agentTools: event.target.checked })));
const saveAgentKey = async () => {
  const input = $("#agent-key");
  const value = input.value.trim();
  if (!value) return;
  input.value = "";
  applyState(await theo.invoke("secret:set", "agentKey", value));
};
$("#agent-key-save").addEventListener("click", saveAgentKey);
$("#agent-key").addEventListener("keydown", (event) => event.key === "Enter" && saveAgentKey());
for (const button of document.querySelectorAll("[data-save]")) {
  button.addEventListener("click", async () => {
    const input = document.getElementById(button.dataset.from);
    input.blur();
    applyState(await theo.invoke("settings:update", { [button.dataset.save]: input.value.trim() }));
  });
}
$("#reset-conversation").addEventListener("click", async () => {
  await cancelEverything();
  await theo.invoke("talk:reset");
  transcript.replaceChildren();
});

// ---------------------------------------------------------------- State

function applyState(next) {
  state = next;
  const { settings, keys } = state;

  $("#hud-voice").textContent = settings.localVoice && state.localVoice.installed
    ? state.localVoice.cloned ? "Your clone (free)" : "Free voice"
    : !keys.minimax ? "Mac built-in" : settings.voiceId ? "Your clone" : "Standard";
  const activeModel = { claude: settings.model.replace("claude-", "").replace(/-(\d)-(\d)$/, " $1.$2"), groq: settings.groqModel.split("/").pop(), local: settings.localModel || "Not chosen", agent: settings.agentModel || "Not chosen" }[settings.provider];
  $("#hud-model").textContent = activeModel;
  $("#hud-model").title = activeModel;
  const missing = {
    claude: keys.anthropic ? "" : "Theo needs an Anthropic key before it can answer. ",
    groq: keys.groq ? "" : "Theo needs a Groq key before it can answer. ",
    local: settings.localModel ? "" : "Choose a local model before Theo can answer. ",
    agent: settings.agentUrl && settings.agentModel ? "" : "Add the agent’s address and name before Theo can pass requests to it. ",
  }[settings.provider];
  $("#hud-hotkey").textContent = settings.shortcut && state.shortcutActive ? settings.shortcut.replace("Alt", "⌥").replace("+", " ") : "None";
  $("#hud-links").replaceChildren(
    ...state.connections.map((connection) => {
      const item = el("li", {}, [
        CONNECTIONS[connection.id].name,
        el("span", {
          className: "link-state",
          textContent: { connected: "Online", available: "Offline", blocked: "Blocked" }[connection.status],
        }),
      ]);
      item.dataset.status = connection.status;
      return item;
    }),
  );

  const note = $("#setup-note");
  if (note) {
    note.hidden = !missing;
    if (missing) {
      const go = el("button", { className: "linkish", textContent: "Open Settings" });
      go.addEventListener("click", () => showView("settings"));
      note.replaceChildren(missing, go);
    }
  }

  const free = settings.localVoice && state.localVoice.installed;
  $("#voice-status").textContent = free
    ? state.localVoice.cloned
      ? "Theo speaks in the voice you created, using the free voice on this Mac."
      : "Theo is using the free voice’s standard voice. Record a sample below to make it sound like you."
    : !keys.minimax
      ? "Theo is using your Mac’s built-in voice. Turn on the free voice below, or add a MiniMax key in Settings, to give it a cloned one."
      : settings.voiceId
        ? "Theo speaks in the voice you created."
        : "Theo is using a standard voice. Record a sample below to make it sound like you.";
  $("#remove-voice").hidden = free ? !state.localVoice.cloned : !settings.voiceId;
  $("#preview-button").hidden = !free && !keys.minimax;
  $("#local-voice").checked = settings.localVoice;
  $("#local-voice").disabled = !state.localVoice.installed;
  $("#local-voice-hint").textContent = !state.localVoice.installed
    ? "Not installed yet. Run voice/setup.sh from the Theo folder, then reopen Theo."
    : "Free and private: nothing is sent anywhere. Each sentence takes about as long to prepare as it does to say, and it uses about 2 GB of memory while on. Making a voice from a recording needs your Groq key, so Theo can note down what the sample says.";

  if (document.activeElement !== $("#shortcut")) $("#shortcut").value = settings.shortcut;
  $("#keep-listening").checked = settings.keepListening;
  $("#wake-enabled").checked = settings.wakeEnabled;
  if (document.activeElement !== $("#wake-word")) $("#wake-word").value = settings.wakeWord;
  $("#hud-wake").textContent = !settings.wakeEnabled ? "Off" : keys.groq ? settings.wakeWord : "Needs Groq key";
  syncWakeListener();
  if (phase === "idle") setPhase("idle");
  $("#confirm-scripts").checked = settings.confirmScripts;
  $("#model").value = settings.model;
  $("#provider").value = settings.provider;
  $("#provider-hint").textContent = {
    claude: "",
    groq: "Open models are quicker but make more mistakes on requests with several steps, and cannot search the web.",
    local: "Nothing leaves this Mac for the thinking step. Start Ollama or LM Studio first. Local models cannot search the web.",
    agent: "Theo becomes the voice and face. What you say is passed to the agent, which thinks and acts with its own tools and memory, and Theo speaks its reply.",
  }[settings.provider];
  for (const field of document.querySelectorAll("[data-provider]")) field.hidden = field.dataset.provider !== settings.provider;
  $("#agent-tools").checked = settings.agentTools;
  $("#agent-key-badge").textContent = keys.agentKey ? "Saved" : "Not added";
  $("#agent-key-badge").dataset.status = keys.agentKey ? "connected" : "available";
  $("#agent-key").placeholder = keys.agentKey ? "Paste a new key to replace it" : "Paste the key";
  for (const [id, key] of [["groq-model", "groqModel"], ["local-url", "localUrl"], ["local-model", "localModel"], ["agent-url", "agentUrl"], ["agent-model", "agentModel"]]) {
    const input = document.getElementById(id);
    if (document.activeElement !== input) input.value = settings[key];
  }

  renderConnections();
  renderKeys();
}

theo.on("state:changed", applyState);
// Access granted in System Settings shows up when the window regains focus.
addEventListener("focus", async () => applyState(await theo.invoke("state:get")));

// ---------------------------------------------------------------- Clock and ruler

let rulerDay = 0;

function tick() {
  const now = new Date();
  $("#hud-time").textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("#hud-date").textContent = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  if (rulerDay === now.getDate()) return;
  rulerDay = now.getDate();
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  $("#ruler-month").textContent = now.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  $("#ruler-days").replaceChildren(
    ...Array.from({ length: days }, (_, index) => {
      const day = el("li", { textContent: String(index + 1).padStart(2, "0") });
      if (index + 1 === rulerDay) day.dataset.today = "";
      return day;
    }),
  );
}

tick();
setInterval(tick, 1000);

theo.invoke("state:get").then((initial) => {
  applyState(initial);
  setPhase("idle");
  requestAnimationFrame(drawCore);
});
})();
