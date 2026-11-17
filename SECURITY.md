# Security policy

DesktopJarvis can read and send your email, change your calendar and reminders, and run
AppleScript on your Mac, so security problems matter here. Thank you for reporting them
responsibly.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub instead:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

You should get a reply within a week. Once the problem is confirmed, we will work on a fix
and credit you in the release notes unless you'd rather not be named.

## Supported versions

Only the latest commit on `main` is supported. There are no older releases receiving fixes.

## What counts

Examples of things we want to hear about:

- Ways for a web page, email, calendar event or other content DesktopJarvis reads to make it
  take actions you did not ask for (prompt injection leading to sending mail, running
  scripts, opening files and so on).
- Ways around the confirmation before AppleScript runs.
- API keys or OAuth tokens leaking: stored unencrypted, written to logs, or sent somewhere
  other than the service they belong to.
- Weaknesses in the window's Content-Security-Policy or the IPC bridge in `src/preload.ts`.

Out of scope: problems that need someone to already have full control of your Mac or user
account, and issues in third-party services (Anthropic, Groq, MiniMax, Google, Microsoft,
OpenClaw) themselves, which should be reported to them.

## Keeping yourself safe

- If you connect another agent (OpenClaw, Hermes), its gateway token gives full control of
  that agent. Keep the gateway on your Mac or a private network.
- Leave "Ask me before DesktopJarvis runs a custom script on this Mac" ticked in Settings.
