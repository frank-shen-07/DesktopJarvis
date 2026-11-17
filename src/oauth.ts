import crypto from "crypto";
import http from "http";
import { shell } from "electron";
import { getSecret, getSettings, setSecret, updateSettings } from "./store";

export type MailProvider = "gmail" | "outlook";

const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/gmail.modify";
const MICROSOFT_SCOPES = "offline_access User.Read Mail.ReadWrite Mail.Send";
const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";

const accessTokens = new Map<MailProvider, { token: string; expiresAt: number }>();

const donePage = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>DesktopJarvis</title>
<body style="font: 17px/1.5 -apple-system, system-ui; margin: 18vh auto; max-width: 28rem; color: #1b1f3b">
<h1 style="font: 600 28px ui-serif, Georgia, serif">${message}</h1>
<p>You can close this tab and go back to DesktopJarvis.</p></body>`;

/**
 * Sign in through the system browser and catch the redirect on a loopback port.
 * PKCE means no long-lived secret has to live in the app for Microsoft.
 */
async function loopbackSignIn(
  buildUrl: (redirectUri: string, challenge: string, state: string) => string,
): Promise<{ code: string; redirectUri: string; verifier: string }> {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    let redirectUri = "";
    let settled = false;
    const servers: http.Server[] = [];
    const finish = (error: Error | null, code = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Let the browser receive the confirmation page before closing.
      setTimeout(() => servers.forEach((server) => server.close()), 500);
      if (error) reject(error);
      else resolve({ code, redirectUri, verifier });
    };

    const handler: http.RequestListener = (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (url.searchParams.get("state") !== state || (!code && !error)) {
        res.end(donePage("That sign-in link was not valid."));
        return;
      }
      if (error || !code) {
        res.end(donePage("Sign-in was cancelled."));
        finish(new Error(error ?? "Sign-in was cancelled"));
        return;
      }
      res.end(donePage("DesktopJarvis is connected."));
      finish(null, code);
    };

    const timer = setTimeout(
      () => finish(new Error("Sign-in timed out after five minutes. Try connecting again.")),
      5 * 60_000,
    );

    const primary = http.createServer(handler);
    servers.push(primary);
    primary.on("error", (error) => finish(error));
    primary.listen(0, "127.0.0.1", () => {
      const { port } = primary.address() as { port: number };
      redirectUri = `http://localhost:${port}`;
      // Browsers may resolve localhost to ::1 first, so answer there too.
      const v6 = http.createServer(handler);
      v6.on("error", () => undefined);
      v6.listen(port, "::1");
      servers.push(v6);
      void shell.openExternal(buildUrl(redirectUri, challenge, state));
    });
  });
}

async function tokenRequest(
  url: string,
  params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    const detail = body.error_description ?? body.error ?? `HTTP ${response.status}`;
    throw new Error(`Sign-in was rejected: ${String(detail).split("\r\n")[0]}`);
  }
  return body as { access_token: string; refresh_token?: string; expires_in: number };
}

function remember(provider: MailProvider, token: string, expiresIn: number): void {
  accessTokens.set(provider, {
    token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  });
}

export async function connectGmail(): Promise<string> {
  const clientId = getSettings().googleClientId.trim();
  const clientSecret = getSecret("googleClientSecret");
  if (!clientId || !clientSecret) {
    throw new Error("Add your Google client ID and client secret first");
  }
  const { code, redirectUri, verifier } = await loopbackSignIn(
    (redirect, challenge, state) =>
      `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      })}`,
  );
  const tokens = await tokenRequest("https://oauth2.googleapis.com/token", {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Try connecting again.");
  }
  setSecret("googleRefresh", tokens.refresh_token);
  remember("gmail", tokens.access_token, tokens.expires_in);

  const profile = (await (
    await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).json()) as { emailAddress?: string };
  const address = profile.emailAddress ?? "Gmail";
  updateSettings({ gmailAddress: address });
  return address;
}

export async function connectOutlook(): Promise<string> {
  const clientId = getSettings().microsoftClientId.trim();
  if (!clientId) throw new Error("Add your Microsoft application (client) ID first");
  const { code, redirectUri, verifier } = await loopbackSignIn(
    (redirect, challenge, state) =>
      `${MICROSOFT_AUTHORITY}/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        response_mode: "query",
        scope: MICROSOFT_SCOPES,
        prompt: "select_account",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      })}`,
  );
  const tokens = await tokenRequest(`${MICROSOFT_AUTHORITY}/token`, {
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    scope: MICROSOFT_SCOPES,
  });
  if (!tokens.refresh_token) {
    throw new Error("Microsoft did not return a refresh token. Try connecting again.");
  }
  setSecret("microsoftRefresh", tokens.refresh_token);
  remember("outlook", tokens.access_token, tokens.expires_in);

  const me = (await (
    await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).json()) as { mail?: string; userPrincipalName?: string };
  const address = me.mail ?? me.userPrincipalName ?? "Outlook";
  updateSettings({ outlookAddress: address });
  return address;
}

export function disconnect(provider: MailProvider): void {
  accessTokens.delete(provider);
  if (provider === "gmail") {
    setSecret("googleRefresh", "");
    updateSettings({ gmailAddress: "" });
  } else {
    setSecret("microsoftRefresh", "");
    updateSettings({ outlookAddress: "" });
  }
}

export function isConnected(provider: MailProvider): boolean {
  return Boolean(getSecret(provider === "gmail" ? "googleRefresh" : "microsoftRefresh"));
}

/** A valid access token for the provider, refreshed when it is close to expiry. */
export async function accessToken(provider: MailProvider): Promise<string> {
  const cached = accessTokens.get(provider);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const label = provider === "gmail" ? "Gmail" : "Outlook";
  const refresh = getSecret(provider === "gmail" ? "googleRefresh" : "microsoftRefresh");
  if (!refresh) throw new Error(`${label} is not connected. Connect it in DesktopJarvis's Connections tab.`);

  try {
    if (provider === "gmail") {
      const tokens = await tokenRequest("https://oauth2.googleapis.com/token", {
        client_id: getSettings().googleClientId.trim(),
        client_secret: getSecret("googleClientSecret"),
        refresh_token: refresh,
        grant_type: "refresh_token",
      });
      remember(provider, tokens.access_token, tokens.expires_in);
      return tokens.access_token;
    }
    const tokens = await tokenRequest(`${MICROSOFT_AUTHORITY}/token`, {
      client_id: getSettings().microsoftClientId.trim(),
      refresh_token: refresh,
      grant_type: "refresh_token",
      scope: MICROSOFT_SCOPES,
    });
    // Microsoft rotates refresh tokens; keep the newest one.
    if (tokens.refresh_token) setSecret("microsoftRefresh", tokens.refresh_token);
    remember(provider, tokens.access_token, tokens.expires_in);
    return tokens.access_token;
  } catch (error) {
    throw new Error(
      `${label} sign-in has expired. Reconnect it in DesktopJarvis's Connections tab. (${
        error instanceof Error ? error.message : error
      })`,
    );
  }
}
