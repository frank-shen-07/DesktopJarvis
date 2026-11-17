# Handover

Where DesktopJarvis stands as of 18 November 2026, and what is left to do. For how to run
it and what it does, see `README.md`; for the window's code, see `renderer/README.md`.

## What it is

An Electron app for Apple Silicon Macs that you talk to. It hears you (push-to-talk, a
global shortcut, or a wake word), thinks with Claude or another model, answers out loud in a
cloned voice, and can act on the Mac. Calendar, reminders and mail are also shown as cards
that an animated dragon "draws" with fire.

## State of the code

**Healthy.** `npm run check` (oxlint, Prettier, both type checks) passes cleanly on `main`.
There are no automated tests; changes have been checked by running the app and comparing
screenshots.

**Recent history**, newest first:

| Commit    | What changed                                                                   |
| --------- | ------------------------------------------------------------------------------ |
| `8e6fcbd` | Menu bar shows a fire-breathing dragon icon instead of text                    |
| `93ab94e` | Window moved to React + Vite + CSS Modules; the dock is the first component    |
| `54c8d67` | Stylesheet split into one file per part of the window                          |
| `ea3d7d6` | Wake word made a little more sensitive                                         |
| `f1ec2b2` | oxlint and Prettier added, code tidied                                         |
| `4d1d816` | Renamed from Theo to DesktopJarvis; wake word easier to trigger                |
| `240636f` | Faster speech (quick replies, sentence-by-sentence), the card board, wake word |

**Project files:** MIT licensed (`LICENSE`), with `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
`SECURITY.md` and issue templates in `.github/`. Security reports go through GitHub's private
vulnerability reporting, which is switched on for the repository.

## How it fits together

Two halves, talking over Electron IPC through `src/preload.ts`.

**Main process (`src/`, TypeScript, compiled by `tsc` to `dist/`)**

| File                  | Role                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `main.ts` (734 lines) | Window, menu bar item, global shortcut, and running one spoken turn                              |
| `agent.ts`            | Tool loop. Providers: `claude`, `groq`, `local` (Ollama / LM Studio), `agent` (OpenClaw, Hermes) |
| `tools.ts`            | The 18 Mac tools: apps, files, Word, Calendar, Reminders, mail, cards, web, AppleScript          |
| `board.ts`            | The cards shown for calendar, reminders, mail and lists                                          |
| `speech.ts`           | Groq speech-to-text, MiniMax speech and voice cloning, Mac voice fallback                        |
| `localVoice.ts`       | Free on-device voice (F5-TTS), driving `voice/server.py`                                         |
| `phrases.ts`          | Quick acknowledgements ("On it") and splitting a stream into sentences                           |
| `oauth.ts`, `mail.ts` | Gmail and Outlook sign-in and mail                                                               |
| `store.ts`            | Settings, and API keys encrypted with `safeStorage`                                              |
| `mac.ts`              | Small macOS helpers                                                                              |

`native/theo-events.swift` is the Calendar and Reminders bridge (built to `native/bin/` by
`npm run build:native`).

**Window (`renderer/`, built by Vite to `dist/renderer/`)**

Partway through a move to React. Only the **dock** is a React component so far
(`renderer/src/components/Dock/`). Everything else still runs from `renderer/src/legacy/`:

| File         | Lines | Role                                                |
| ------------ | ----- | --------------------------------------------------- |
| `app.js`     | 1,445 | The rest of the interface                           |
| `dragon.js`  | 1,581 | The hologram dragon, drawn entirely by code         |
| `forge.js`   | 326   | The fire that draws the cards, aimed from the mouth |
| `hearing.js` | 134   | Listening for the wake word                         |

Legacy areas are styled by the global stylesheets in `renderer/src/styles/`. Shared colours
and fonts are CSS variables in `base.css`. `navigation.ts` holds the current tab so React and
legacy code switch tabs the same way (`showView()`).

## Things to know

- **Test permissions in the packaged app**, not `npm run dev`. macOS only shows the Calendar,
  Reminders and Word prompts for the packaged build, and every rebuild is a new ad-hoc
  signature, so it asks again each time.
- **Keys** (Anthropic, Groq, MiniMax) are entered in the Settings tab, not in env files.
- **The packaged app keeps a strict Content-Security-Policy**; only the dev server relaxes it
  for Vite.
- **Lint is oxlint, not ESLint**, because typescript-eslint does not support TypeScript 7 yet.
- **The old name lingers** in places that were not renamed: `native/theo-events.swift`, the
  `~/.theo/voice` install folder, the `app.theo.assistant` app id, and `[theo]` console logs.
  Renaming the app id or the folder would lose existing permissions and the installed voice,
  so do it deliberately if at all.
- `profile/` is a local Electron profile used during development and is git-ignored.

## To do

### 1. Replace the code-drawn dragon with a Blender model (in progress)

Fully written up in `TODO.md`: how the current dragon works, how to model it (head facing
the camera, about 2 units wide, under ~50k triangles), the shape keys it needs (`JawOpen`,
`Blink`, optional `Snarl`), the `Mouth` empty that `forge.js` aims the fire from, export
settings, and the plan for wiring it in with three.js. **Waiting on** the model file at
`renderer/public/models/dragon.glb`.

### 2. Keep moving the window into React components

Step-by-step recipe in `renderer/README.md` ("Moving another area into a component").
Start with small, self-contained areas (the Voice tab, Settings, Connections); leave the Talk
tab and the board for last, as they are the most tangled with `app.js`. Each move should
delete the matching global stylesheet and shrink `app.js`. Done when `legacy/` is empty.

### 3. Smaller items worth considering

- **Tests.** None exist. The pure logic is the easiest place to start: sentence splitting in
  `phrases.ts`, card building in `board.ts`, and settings defaults in `store.ts`.
- **`main.ts` is large** (734 lines). The spoken-turn logic could move into its own file.
- **Finish the rename** where it is safe (log prefix, the Swift file name), per the note
  above.
