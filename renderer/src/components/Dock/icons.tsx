/** The dock's tab icons, drawn on a 24×24 grid. */

export function TalkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5M12 20.5A8.5 8.5 0 0 1 3.5 12"
        fill="none"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ConnectionsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="12" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="18" cy="18" r="2.4" />
      <path d="M8 11l8-4M8 13l8 4" fill="none" strokeWidth="1.6" />
    </svg>
  );
}

export function VoiceIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12v0M8 8v8M12 4.5v15M16 8v8M20 11v2" fill="none" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" fill="none" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="15" cy="7" r="2" fill="none" strokeWidth="1.8" />
      <circle cx="9" cy="12" r="2" fill="none" strokeWidth="1.8" />
      <circle cx="17" cy="17" r="2" fill="none" strokeWidth="1.8" />
    </svg>
  );
}
