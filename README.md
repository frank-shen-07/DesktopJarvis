# DesktopJarvis

A Mac app you talk to. It answers in a cloned voice and can act on your Mac:
open apps and files, create Word documents, read and add Calendar events and
Reminders, read and send Gmail and Outlook mail, and browse the web.

## Demo

https://github.com/user-attachments/assets/8cb0a9d0-b73e-4443-a562-a5f3c63663b7


## Documentation

The full guides are in [`docs/`](docs/README.md):

- [Getting started](docs/getting-started.md): install, keys and your first conversation
- [Using DesktopJarvis](docs/using.md): ways to talk, what it can do, the cards, settings
- [Connections and services](docs/connections.md): Gmail, Outlook, Calendar, models, voices
- [Privacy and safety](docs/privacy-and-safety.md): what leaves your Mac, and what asks first
- [Troubleshooting](docs/troubleshooting.md)
- [How the code fits together](docs/architecture.md) and the [development guide](docs/development.md)

## How a turn goes

DesktopJarvis answers in pieces instead of all at once:

- The moment a request is heard it says a short "On it" or "Let me check". The audio
  for these is made once per voice and kept, so it plays without a wait.
- While it works it says what it is doing: Claude's own notes between steps, or the
  name of the step ("Checking your calendar") when it has been quiet for a couple of
  seconds.
- The answer is spoken sentence by sentence as Claude writes it, so the first words
  are heard while the rest is still being written.

Turn the first two off in Settings › Talking if you want it quieter. Each turn prints
its timings to the console (`[theo] turn: …`) when started with `npm run dev`.

Calendar events, reminders and email are also put on screen as cards, which the dragon
draws under itself. Tick a reminder to complete it, click an email to have it read
out, and press Escape or Close to put the cards away. DesktopJarvis can put up its own lists
the same way, for example a plan for the day.

## Run it

```bash
npm install
npm run app     # builds release/mac-arm64/DesktopJarvis.app
npm run open    # launches it
```

While working on the window, `npm run dev` opens the app with live reloading.

Use the packaged app rather than `npm run dev` when testing Calendar, Reminders
or Word: macOS only shows those permission prompts for the packaged build.
Each rebuild is a new signature, so macOS asks for the permissions again.

## Lint and format

```sh
npm run check    # oxlint, Prettier and a type check; run before committing
npm run lint:fix # apply oxlint's automatic fixes
npm run format   # rewrite files in Prettier style
```

Linting uses [oxlint](https://oxc.rs) rather than ESLint, because typescript-eslint does not support TypeScript 7 yet. Rules are in `.oxlintrc.json`.

## Keys (Settings tab)

| Key       | Used for                          | Needed                                                   |
| --------- | --------------------------------- | -------------------------------------------------------- |
| Anthropic | Claude decides what to say and do | When Claude does the thinking                            |
| Groq      | Speech to text                    | For talking; typing works without it                     |
| MiniMax   | Voice cloning and speech          | For the cloned voice; the Mac's voice is used without it |

## Free voice on this Mac

DesktopJarvis can speak, and clone a voice, with an open model (F5-TTS) that runs on
Apple Silicon instead of MiniMax. Nothing is sent anywhere and it costs nothing.

```bash
npm run voice:setup   # installs it into ~/.theo/voice (needs Homebrew Python)
```

Then tick "Speak with the free voice" on the Voice tab. The model (about 1.3 GB)
downloads the first time it speaks. On an 8 GB M1 each sentence takes about as
long to prepare as it does to say. Cloning uses the Groq key to transcribe the
sample.

## Using another agent (OpenClaw, Hermes)

In Settings, under Thinking, choose "Another agent". DesktopJarvis then passes what you
say to that agent and speaks its reply; the agent thinks and acts with its own
tools and memory. Tick the box there to also offer it DesktopJarvis's Mac tools.

OpenClaw:

1. Switch on its OpenAI endpoint in the gateway config and restart the gateway:
   `gateway.http.endpoints.chatCompletions.enabled: true`
2. In DesktopJarvis, keep the address `http://127.0.0.1:18789/v1` and the name
   `openclaw/default`, and paste the gateway token as the agent key.

That token gives full control of the OpenClaw gateway, so keep the gateway on
this Mac or a private network. Hermes Agent works the same way at
`http://127.0.0.1:8642/v1` with its `API_SERVER_KEY`.

## Layout

- `src/main.ts` window, menu bar item, global shortcut, one spoken turn
- `src/agent.ts` tool loop for Claude, Groq, local models and other agents
- `src/tools.ts` everything DesktopJarvis can do on the Mac
- `src/oauth.ts`, `src/mail.ts` Gmail and Outlook sign-in and mail
- `src/speech.ts` transcription, speech, voice cloning
- `src/phrases.ts` the quick acknowledgements, and sentences out of a stream
- `src/board.ts` the cards shown for calendar, reminders, mail and lists
- `src/localVoice.ts`, `voice/server.py` the free voice that runs on this Mac
- `native/theo-events.swift` Calendar and Reminders bridge
- `assets/tray-icon.svg` the menu bar dragon, whose fire flickers while DesktopJarvis is working;
  open it in a browser to watch the animation, and run `npm run build:icon` after editing it
- `renderer/` the window: React components with CSS Modules, built by Vite. See
  `renderer/README.md` for how it is laid out and how to work on it

## License

MIT. See [LICENSE](LICENSE).
