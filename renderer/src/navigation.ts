/**
 * Which tab is showing. Anything can switch tabs with showView(), and React components
 * read the current tab with useCurrentView(), which re-renders them when it changes.
 */
import { useSyncExternalStore } from "react";

export type View = "talk" | "connections" | "voice" | "settings";

let current: View = "talk";
const listeners = new Set<() => void>();

export function showView(view: View): void {
  current = view;
  for (const section of document.querySelectorAll<HTMLElement>(".view")) {
    section.hidden = section.id !== `view-${view}`;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCurrentView(): View {
  return useSyncExternalStore(subscribe, () => current);
}
