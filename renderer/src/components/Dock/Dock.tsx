import type { JSX } from "react";
import { type View, showView, useCurrentView } from "../../navigation";
import styles from "./Dock.module.css";
import { ConnectionsIcon, SettingsIcon, TalkIcon, VoiceIcon } from "./icons";

const TABS: { view: View; label: string; Icon: () => JSX.Element }[] = [
  { view: "talk", label: "Talk", Icon: TalkIcon },
  { view: "connections", label: "Connections", Icon: ConnectionsIcon },
  { view: "voice", label: "Voice", Icon: VoiceIcon },
  { view: "settings", label: "Settings", Icon: SettingsIcon },
];

/** The row of tab buttons along the bottom of the window. */
export function Dock() {
  const current = useCurrentView();
  return (
    <nav className={styles.dock} aria-label="Sections">
      {TABS.map(({ view, label, Icon }) => (
        <button
          key={view}
          className={styles.item}
          aria-current={view === current ? "page" : undefined}
          onClick={() => showView(view)}
        >
          <span className={styles.ring}>
            <Icon />
          </span>
          <span className={styles.label}>{label}</span>
        </button>
      ))}
    </nav>
  );
}
