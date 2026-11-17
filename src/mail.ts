import { accessToken, type MailProvider } from "./oauth";

export interface MailSummary {
  account: MailProvider;
  id: string;
  from: string;
  subject: string;
  received: string;
  unread: boolean;
  preview: string;
}

export interface OutgoingMail {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
}

async function api<T>(provider: MailProvider, url: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(provider);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`${provider === "gmail" ? "Gmail" : "Outlook"} returned HTTP ${response.status}: ${detail}`);
  }
  if (response.status === 202 || response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function clip(text: string, max: number): string {
  const clean = text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}\n[…message truncated]` : clean;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

// ---------- Gmail ----------

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}
interface GmailMessage {
  id: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function findPart(part: GmailPart | undefined, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return null;
}

async function gmailList(unreadOnly: boolean, query: string, limit: number) {
  const q = ["in:inbox", unreadOnly ? "is:unread" : "", query].filter(Boolean).join(" ");
  const list = await api<{ messages?: { id: string }[] }>(
    "gmail",
    `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(limit) })}`,
  );
  const messages = await Promise.all(
    (list.messages ?? []).map((item) =>
      api<GmailMessage>(
        "gmail",
        `${GMAIL}/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      ),
    ),
  );
  return messages.map<MailSummary>((message) => ({
    account: "gmail",
    id: message.id,
    from: header(message, "From"),
    subject: header(message, "Subject"),
    received: new Date(Number(message.internalDate ?? 0)).toISOString(),
    unread: message.labelIds?.includes("UNREAD") ?? false,
    preview: message.snippet ?? "",
  }));
}

async function gmailRead(id: string) {
  const message = await api<GmailMessage>("gmail", `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
  const plain = findPart(message.payload, "text/plain");
  const html = plain ? null : findPart(message.payload, "text/html");
  return {
    from: header(message, "From"),
    to: header(message, "To"),
    subject: header(message, "Subject"),
    received: new Date(Number(message.internalDate ?? 0)).toISOString(),
    body: clip(plain ?? (html ? htmlToText(html) : (message.snippet ?? "")), 8000),
  };
}

function encodeHeader(value: string): string {
  // Non-ASCII header values must be RFC 2047 encoded.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function rfc822(mail: OutgoingMail): string {
  const lines = [
    `To: ${mail.to.join(", ")}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.body, "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

// ---------- Outlook (Microsoft Graph) ----------

const GRAPH = "https://graph.microsoft.com/v1.0/me";

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  isRead?: boolean;
  bodyPreview?: string;
  body?: { content?: string };
}

function graphSender(message: GraphMessage): string {
  const sender = message.from?.emailAddress;
  return sender ? `${sender.name ?? ""} <${sender.address ?? ""}>`.trim() : "";
}

async function outlookList(unreadOnly: boolean, query: string, limit: number) {
  const params = new URLSearchParams({
    $top: String(limit),
    $select: "id,subject,from,receivedDateTime,isRead,bodyPreview",
  });
  if (query) {
    // Graph does not allow $search together with $orderby or $filter.
    params.set("$search", `"${query.replace(/"/g, "")}"`);
  } else {
    params.set("$orderby", "receivedDateTime desc");
    if (unreadOnly) params.set("$filter", "isRead eq false");
  }
  const list = await api<{ value: GraphMessage[] }>("outlook", `${GRAPH}/mailFolders/inbox/messages?${params}`);
  return list.value
    .filter((message) => !(query && unreadOnly) || message.isRead === false)
    .map<MailSummary>((message) => ({
      account: "outlook",
      id: message.id,
      from: graphSender(message),
      subject: message.subject ?? "",
      received: message.receivedDateTime ?? "",
      unread: message.isRead === false,
      preview: message.bodyPreview ?? "",
    }));
}

async function outlookRead(id: string) {
  const message = await api<GraphMessage>(
    "outlook",
    `${GRAPH}/messages/${encodeURIComponent(id)}?$select=subject,from,toRecipients,receivedDateTime,body`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } },
  );
  return {
    from: graphSender(message),
    to: (message.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").join(", "),
    subject: message.subject ?? "",
    received: message.receivedDateTime ?? "",
    body: clip(message.body?.content ?? "", 8000),
  };
}

function graphMessage(mail: OutgoingMail) {
  const recipients = (addresses: string[] = []) => addresses.map((address) => ({ emailAddress: { address } }));
  return {
    subject: mail.subject,
    body: { contentType: "Text", content: mail.body },
    toRecipients: recipients(mail.to),
    ccRecipients: recipients(mail.cc),
  };
}

// ---------- Provider-neutral entry points ----------

export async function listMail(
  provider: MailProvider,
  options: { unreadOnly: boolean; query: string; limit: number },
): Promise<MailSummary[]> {
  const limit = Math.min(25, Math.max(1, options.limit));
  return provider === "gmail"
    ? gmailList(options.unreadOnly, options.query, limit)
    : outlookList(options.unreadOnly, options.query, limit);
}

export function readMail(provider: MailProvider, id: string) {
  return provider === "gmail" ? gmailRead(id) : outlookRead(id);
}

export async function sendMail(provider: MailProvider, mail: OutgoingMail): Promise<void> {
  if (provider === "gmail") {
    await api("gmail", `${GMAIL}/messages/send`, {
      method: "POST",
      body: JSON.stringify({ raw: rfc822(mail) }),
    });
  } else {
    await api("outlook", `${GRAPH}/sendMail`, {
      method: "POST",
      body: JSON.stringify({ message: graphMessage(mail), saveToSentItems: true }),
    });
  }
}

export async function draftMail(provider: MailProvider, mail: OutgoingMail): Promise<void> {
  if (provider === "gmail") {
    await api("gmail", `${GMAIL}/drafts`, {
      method: "POST",
      body: JSON.stringify({ message: { raw: rfc822(mail) } }),
    });
  } else {
    await api("outlook", `${GRAPH}/messages`, {
      method: "POST",
      body: JSON.stringify(graphMessage(mail)),
    });
  }
}
