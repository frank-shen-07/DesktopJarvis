"""DesktopJarvis's free local voice: F5-TTS on Apple Silicon, kept warm behind a tiny local server.

Started by DesktopJarvis with a port and a token. It speaks text in the voice of a short reference
recording, and never listens on anything but this Mac.

  GET  /health  -> {"ready": true}
  POST /speak   {"text", "reference": path to a 24 kHz mono WAV or null, "reference_text"}
                -> WAV audio
"""

import argparse
import io
import json
import os
import pkgutil
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import mlx.core as mx
import numpy as np
import soundfile as sf

# The model code passes array values where current MLX wants plain integers.
_normal = mx.random.normal
mx.random.normal = lambda shape=(), *args, **kwargs: _normal(tuple(int(n) for n in shape), *args, **kwargs)

from f5_tts_mlx.cfm import F5TTS  # noqa: E402
from f5_tts_mlx.utils import convert_char_to_pinyin  # noqa: E402

SAMPLE_RATE = 24_000
HOP_LENGTH = 256
TARGET_RMS = 0.1
# Eight Euler steps is about four times faster than the model's default and close in quality.
STEPS = 8
METHOD = "euler"
STOCK_TEXT = "Some call me nature, others call me mother nature."

# The model is loaded and run on the main thread only: MLX ties its arrays to the thread
# that made them. Requests arrive on other threads and wait here for their turn.
jobs = queue.Queue()
model = None
references = {}


def reference(path, text):
    """The recording to imitate, loaded once per file. Without one, the model's own sample voice."""
    if not path:
        if "stock" not in references:
            data = pkgutil.get_data("f5_tts_mlx", "tests/test_en_1_ref_short.wav")
            audio, _ = sf.read(io.BytesIO(data))
            references["stock"] = (prepare(audio), STOCK_TEXT)
        return references["stock"]
    key = (path, os.path.getmtime(path), text)
    if key not in references:
        audio, rate = sf.read(path)
        if rate != SAMPLE_RATE:
            raise ValueError("The voice sample must be 24 kHz")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        references.clear()
        references[key] = (prepare(audio), text)
    return references[key]


def prepare(audio):
    audio = mx.array(audio.astype(np.float32))
    rms = mx.sqrt(mx.mean(mx.square(audio)))
    if rms.item() < TARGET_RMS:
        audio = audio * TARGET_RMS / rms
    return audio


def speak(text, path, reference_text):
    audio, spoken = reference(path, reference_text)
    # Speech length is guessed from how fast the sample was spoken.
    sample_frames = audio.shape[0] // HOP_LENGTH
    frames = sample_frames + int(sample_frames / max(1, len(spoken.encode("utf-8"))) * len(text.encode("utf-8")))
    wave, _ = model.sample(
        mx.expand_dims(audio, axis=0),
        text=convert_char_to_pinyin([spoken + " " + text]),
        duration=frames,
        steps=STEPS,
        method=METHOD,
        cfg_strength=2.0,
        sway_sampling_coef=-1.0,
        speed=1.0,
    )
    wave = wave[audio.shape[0]:]
    mx.eval(wave)
    samples = np.clip(np.array(wave), -1.0, 1.0)
    mx.clear_cache()
    out = io.BytesIO()
    sf.write(out, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return out.getvalue()


class Handler(BaseHTTPRequestHandler):
    token = ""

    def log_message(self, *args):
        pass

    def reply(self, status, body, kind="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        if self.headers.get("X-Theo-Token") == self.token:
            return True
        self.reply(403, {"error": "Not allowed"})
        return False

    def do_GET(self):
        if self.allowed():
            self.reply(200, {"ready": model is not None})

    def do_POST(self):
        if not self.allowed():
            return
        try:
            request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            text = str(request.get("text", "")).strip()
            if not text:
                raise ValueError("Nothing to say")
            done = threading.Event()
            job = {"text": text, "reference": request.get("reference"), "reference_text": str(request.get("reference_text") or ""), "done": done}
            jobs.put(job)
            done.wait()
            if "error" in job:
                raise RuntimeError(job["error"])
            self.reply(200, job["audio"], "audio/wav")
        except Exception as error:  # the caller shows this to the person
            self.reply(500, {"error": str(error)})


def main():
    global model
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    Handler.token = os.environ.get("THEO_VOICE_TOKEN", "")
    # 8-bit weights halve the memory for little audible cost.
    model = F5TTS.from_pretrained("lucasnewman/f5-tts-mlx", quantization_bits=8)
    # Current MLX wants this as a plain number, not an array.
    for _, module in model.named_modules():
        if hasattr(module, "_scale_factor"):
            module._scale_factor = float(module._scale_factor)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("READY", flush=True)

    parent = os.getppid()
    while True:
        try:
            job = jobs.get(timeout=2)
        except queue.Empty:
            # DesktopJarvis has gone away without stopping us: do not linger holding memory.
            if os.getppid() != parent:
                return 0
            continue
        try:
            job["audio"] = speak(job["text"], job["reference"], job["reference_text"])
        except Exception as error:  # the caller shows this to the person
            job["error"] = str(error)
        job["done"].set()


if __name__ == "__main__":
    sys.exit(main())
