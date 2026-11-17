# Theo desktop

A Mac app you talk to. It answers in a cloned voice and can act on your Mac:
open apps and files, create Word documents, read and add Calendar events and
Reminders, read and send Gmail and Outlook mail, and browse the web.

## Run it

```bash
npm install
npm run app     # builds release/mac-arm64/Theo.app
npm run open    # launches it
```

Use the packaged app rather than `npm run dev` when testing Calendar, Reminders
or Word: macOS only shows those permission prompts for the packaged build.
Each rebuild is a new signature, so macOS asks for the permissions again.

## Keys (Settings tab)

| Key | Used for | Needed |
|---|---|---|
| Anthropic | Claude decides what to say and do | When Claude does the thinking |
| Groq | Speech to text | For talking; typing works without it |
| MiniMax | Voice cloning and speech | For the cloned voice; the Mac's voice is used without it |

## Free voice on this Mac

Theo can speak, and clone a voice, with an open model (F5-TTS) that runs on
Apple Silicon instead of MiniMax. Nothing is sent anywhere and it costs nothing.

```bash
npm run voice:setup   # installs it into ~/.theo/voice (needs Homebrew Python)
```

Then tick "Speak with the free voice" on the Voice tab. The model (about 1.3 GB)
downloads the first time it speaks. On an 8 GB M1 each sentence takes about as
long to prepare as it does to say. Cloning uses the Groq key to transcribe the
sample.

## Using another agent (OpenClaw, Hermes)

In Settings, under Thinking, choose "Another agent". Theo then passes what you
say to that agent and speaks its reply; the agent thinks and acts with its own
tools and memory. Tick the box there to also offer it Theo's Mac tools.

OpenClaw:

1. Switch on its OpenAI endpoint in the gateway config and restart the gateway:
   `gateway.http.endpoints.chatCompletions.enabled: true`
2. In Theo, keep the address `http://127.0.0.1:18789/v1` and the name
   `openclaw/default`, and paste the gateway token as the agent key.

That token gives full control of the OpenClaw gateway, so keep the gateway on
this Mac or a private network. Hermes Agent works the same way at
`http://127.0.0.1:8642/v1` with its `API_SERVER_KEY`.

## Layout

- `src/main.ts` window, menu bar item, global shortcut, one spoken turn
- `src/agent.ts` tool loop for Claude, Groq, local models and other agents
- `src/tools.ts` everything Theo can do on the Mac
- `src/oauth.ts`, `src/mail.ts` Gmail and Outlook sign-in and mail
- `src/speech.ts` transcription, speech, voice cloning
- `src/localVoice.ts`, `voice/server.py` the free voice that runs on this Mac
- `native/theo-events.swift` Calendar and Reminders bridge
- `renderer/` the interface (`dragon.js` is the hologram dragon behind the core)
