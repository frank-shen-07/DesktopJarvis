# Accessibility

DesktopJarvis should be usable by everyone, including people who find a keyboard, a mouse or
a screen hard to use. We treat accessibility barriers as bugs, and fix them like any other.

This statement describes where the app stands today. It hasn't yet been tested with
assistive technology, so some of what follows is what the app is built to do rather than
what has been confirmed.

## Supported environment

- macOS on an Apple Silicon Mac (M1 or later).
- The packaged app (`npm run app`), in English.

## What works today

- **More than one way to make a request.** Speak (hold Space, click the core, the global
  shortcut, or the wake word) or type. Everything you can say, you can type.
- **Answers are spoken and written.** Every reply is read aloud and also appears in the
  comms log, so neither hearing nor reading it is required.
- **Screen reader support in the window.** The comms log announces new text as it arrives,
  buttons have labels, approval prompts are announced as alerts, and the current tab is
  marked in the dock.
- **Keyboard use.** Every control is a standard button, field or checkbox, and keyboard focus
  is shown with a visible outline. Escape stops an answer or closes the cards.
- **Reduced motion.** With **Reduce motion** on in System Settings › Accessibility › Display,
  the dragon holds still and the fire animation is skipped.
- **Hands-free use.** With the wake word on, and **Keep listening after DesktopJarvis
  answers**, a conversation needs no keyboard or mouse at all.

## Known limitations

- **Not yet tested with VoiceOver, Voice Control or Switch Control**, or keyboard-only from
  start to finish.
- **Typed requests are text only.** You can't attach images, audio or video.
- **Dark appearance only.** The window doesn't follow the Light appearance or Increase
  Contrast settings, and some of the hologram-style text is low contrast.
- **Speech recognition** may misunderstand some accents and speech patterns, and the wake
  word may be harder to trigger. Typing always works as a fallback.
- **Spoken replies have no speed or volume control** in the app; use the Mac's volume.
- **The dragon and cards are visual.** Card contents are also read aloud or written in the
  comms log, but the cards themselves haven't been checked with a screen reader.
- **Setting up Gmail and Outlook** goes through Google's and Microsoft's own websites, which
  are outside our control.

## Reporting a barrier

If something gets in your way, please
[open an accessibility issue](https://github.com/frank-shen-07/DesktopJarvis/issues/new?template=accessibility.yml).
Tell us what you were trying to do, what got in the way, and any assistive technology you
use. We aim to reply within a week.
