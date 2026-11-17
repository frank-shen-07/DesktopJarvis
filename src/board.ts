import { MailSummary } from "./mail";

/**
 * The board: cards Theo puts on screen beside what it says, so a list of events,
 * emails or things to do can be looked at instead of listened to.
 */

export interface BoardCard {
  /** The small line above the title: a time, a sender. */
  kicker?: string;
  title: string;
  detail?: string;
  /** A short label in the corner: the calendar, the list, when it arrived. */
  tag?: string;
  /** Long text, for a single email shown in full. */
  body?: string;
  state?: "past" | "now" | "new" | "late" | "added";
  /** A tick box. With a reminder id, ticking it completes that reminder on the Mac. */
  check?: { reminderId?: string };
  /** What clicking the card asks Theo to do. */
  ask?: string;
}

export interface BoardSection {
  kind: "calendar" | "mail" | "reminders" | "message" | "list";
  title: string;
  note?: string;
  /** Shown in place of cards when there are none. */
  empty?: string;
  cards: BoardCard[];
}

const DAY = 86_400_000;

const clock = (date: Date) => date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const shortDay = (date: Date) => date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const longDay = (date: Date) => date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Today", "Tomorrow" or "Yesterday" where one applies. */
function nearDay(date: Date, now = new Date()): string | null {
  const days = Math.round((midnight(date) - midnight(now)) / DAY);
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : null;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

// ---------- Calendar ----------

export interface CalendarEvent {
  title?: unknown;
  start?: unknown;
  end?: unknown;
  allDay?: unknown;
  calendar?: unknown;
  location?: unknown;
}

function eventCard(event: CalendarEvent, withDay: boolean, now: number): BoardCard {
  const start = new Date(Number(event.start) * 1000);
  const end = new Date(Number(event.end) * 1000);
  const allDay = event.allDay === true;
  const hours = allDay ? "All day" : `${clock(start)} – ${clock(end)}`;
  return {
    kicker: withDay ? `${nearDay(start) ?? shortDay(start)} · ${hours}` : hours,
    title: String(event.title || "Untitled event"),
    detail: event.location ? clip(String(event.location), 90) : undefined,
    tag: event.calendar ? String(event.calendar) : undefined,
    state: allDay ? undefined : end.getTime() < now ? "past" : start.getTime() <= now ? "now" : undefined,
  };
}

/** Events between two times, as an agenda. Times are seconds since 1970. */
export function calendarSection(events: CalendarEvent[], startEpoch: number, endEpoch: number): BoardSection {
  const start = new Date(startEpoch * 1000);
  // A range that ends at midnight belongs to the day before.
  const last = new Date(endEpoch * 1000 - 1000);
  const oneDay = midnight(start) === midnight(last);
  const sorted = [...events].sort((a, b) => Number(a.start) - Number(b.start));
  const now = Date.now();
  return {
    kind: "calendar",
    title: oneDay ? (nearDay(start) ?? longDay(start)) : `${shortDay(start)} – ${shortDay(last)}`,
    note: sorted.length ? plural(sorted.length, "event") : undefined,
    empty: "Nothing scheduled",
    cards: sorted.map((event) => eventCard(event, !oneDay, now)),
  };
}

export function addedEventSection(event: CalendarEvent): BoardSection {
  return {
    kind: "calendar",
    title: "Added to your calendar",
    cards: [{ ...eventCard(event, true, 0), state: "added" }],
  };
}

// ---------- Reminders ----------

export interface Reminder {
  id?: unknown;
  title?: unknown;
  due?: unknown;
  list?: unknown;
}

function reminderCard(reminder: Reminder, now: Date): BoardCard {
  let kicker = "No date";
  let late = false;
  if (typeof reminder.due === "number") {
    const due = new Date(reminder.due * 1000);
    // A reminder with a day but no time is stored at midnight.
    const timed = due.getHours() !== 0 || due.getMinutes() !== 0;
    late = timed ? due.getTime() < now.getTime() : midnight(due) < midnight(now);
    kicker = `${nearDay(due, now) ?? shortDay(due)}${timed ? ` ${clock(due)}` : ""}`;
    if (late) kicker = `Overdue · ${kicker}`;
  }
  return {
    kicker,
    title: String(reminder.title || "Untitled reminder"),
    tag: reminder.list ? String(reminder.list) : undefined,
    state: late ? "late" : undefined,
    check: { reminderId: typeof reminder.id === "string" ? reminder.id : undefined },
  };
}

export function remindersSection(reminders: Reminder[], title = "Reminders"): BoardSection {
  const now = new Date();
  return {
    kind: "reminders",
    title,
    note: reminders.length && title === "Reminders" ? `${reminders.length} open` : undefined,
    empty: "Nothing left to do",
    cards: reminders.map((reminder) => reminderCard(reminder, now)),
  };
}

// ---------- Mail ----------

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** "Ada Lovelace <ada@example.com>" as just the name. */
function senderName(from: string): string {
  const name = from.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim();
  return name || from.replace(/[<>]/g, "").trim() || "Unknown sender";
}

function received(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((midnight(now) - midnight(date)) / DAY);
  if (days <= 0) return clock(date);
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-GB", { weekday: "short" });
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Gmail's previews arrive with HTML entities left in. */
function plain(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[​-‏͏﻿]/g, "");
}

export function mailSection(messages: MailSummary[], options: { unreadOnly: boolean; query: string }): BoardSection {
  const unread = messages.filter((message) => message.unread).length;
  const service = messages[0]?.account === "outlook" ? "Outlook" : messages[0]?.account === "gmail" ? "Gmail" : "";
  return {
    kind: "mail",
    title: options.query ? `Mail · “${clip(options.query, 28)}”` : options.unreadOnly ? "Unread mail" : "Inbox",
    note: [service, unread ? `${unread} unread` : ""].filter(Boolean).join(" · ") || undefined,
    empty: options.unreadOnly ? "No unread mail" : "No mail found",
    cards: messages.map((message, index) => ({
      kicker: senderName(message.from),
      title: plain(message.subject).trim() || "(no subject)",
      detail: clip(plain(message.preview), 140) || undefined,
      tag: received(message.received),
      state: message.unread ? ("new" as const) : undefined,
      // Clicking a card speaks for the person, so the request names the email by its
      // place in the list and never repeats words that its sender chose.
      ask: `Read me ${index < ORDINALS.length ? `the ${ORDINALS[index]} email` : `email number ${index + 1}`} in that list.`,
    })),
  };
}

export function messageSection(mail: { from: string; subject: string; received: string; body: string }): BoardSection {
  return {
    kind: "message",
    title: "Message",
    cards: [
      {
        kicker: senderName(mail.from),
        title: mail.subject.trim() || "(no subject)",
        tag: received(mail.received),
        body: mail.body.length > 1500 ? `${mail.body.slice(0, 1500).trimEnd()}…` : mail.body,
      },
    ],
  };
}

// ---------- Anything else Theo decides to show ----------

export function listSection(input: { title: string; checklist: boolean; items: { title: string; detail?: string; when?: string }[] }): BoardSection {
  return {
    kind: "list",
    title: clip(input.title, 48),
    cards: input.items.slice(0, 24).map((item) => ({
      kicker: item.when ? clip(item.when, 40) : undefined,
      title: clip(item.title, 120),
      detail: item.detail ? clip(item.detail, 180) : undefined,
      check: input.checklist ? {} : undefined,
    })),
  };
}
