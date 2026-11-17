#!/bin/sh
# Installs DesktopJarvis's free local voice (F5-TTS for Apple Silicon) into ~/.theo/voice.
# Needs an Apple Silicon build of Python 3.10 or newer, for example from Homebrew.
set -e
PYTHON="${PYTHON:-}"
for candidate in /opt/homebrew/bin/python3.11 /opt/homebrew/bin/python3.12 /opt/homebrew/bin/python3.13 /opt/homebrew/bin/python3; do
  if [ -z "$PYTHON" ] && [ -x "$candidate" ]; then PYTHON="$candidate"; fi
done
if [ -z "$PYTHON" ]; then
  echo "No Apple Silicon Python found. Install one with: brew install python@3.11" >&2
  exit 1
fi
mkdir -p "$HOME/.theo/voice"
"$PYTHON" -m venv "$HOME/.theo/voice/venv"
"$HOME/.theo/voice/venv/bin/pip" install --quiet --upgrade pip
"$HOME/.theo/voice/venv/bin/pip" install --quiet "f5-tts-mlx==0.2.6"
echo "Local voice installed. The voice model (about 1.3 GB) downloads the first time DesktopJarvis speaks with it."
