# Contributing

Thanks for helping with DesktopJarvis. Bug reports, ideas and pull requests are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Found a bug or have an idea?** Open an issue using one of the templates.
- **Found a security problem?** Don't open an issue; follow [SECURITY.md](SECURITY.md).
- **Planning a large change?** Open an issue first so we can agree on the approach before you
  spend time on it.

## Setting up

You need an Apple Silicon Mac, Node.js, and Xcode's command line tools (for `swiftc`).

```sh
npm install
npm run dev     # opens the app with live reloading of the window
npm run app     # builds release/mac-arm64/DesktopJarvis.app
npm run open    # launches the packaged app
```

Add your own Anthropic, Groq and MiniMax keys in the app's Settings tab. Test anything that
touches Calendar, Reminders or Word with the packaged app: macOS only shows those permission
prompts for the packaged build.

[`docs/HANDOVER.md`](../docs/HANDOVER.md) describes how the code fits together, and
[`renderer/README.md`](../renderer/README.md) explains the
window's code and how to move an area of it into a React component.

## Making a change

1. Branch from `main`.
2. Keep the change focused on one thing.
3. Match the surrounding code: plain names, short comments that say why, not what.
4. New parts of the window go in `renderer/src/components/` as React components with a CSS
   Module, not in `renderer/src/legacy/`.
5. Run `npm run check` (oxlint, Prettier and type checks) and make sure it passes.
6. Run the app and try your change. For visual changes, include before and after
   screenshots in the pull request.

## Commit messages

Write the subject as a short, plain sentence in the imperative, describing what the change
does for the person using the app, for example "Make the wake word a little more sensitive".
Use the body to explain why, and how you checked it.

## Pull requests

Describe what changed, why, and how you tested it. Link the issue it fixes, if there is one.
Never include real API keys, tokens, email or calendar data in code, screenshots or logs; use
made-up sample data.
