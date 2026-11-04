// OAuth refresh-token auth (NOT domain-wide delegation).
//
// Reuses the Gmail OAuth2 credential that the n8n "Gmail account" credential
// already had james@ authorize. We exchange its long-lived refresh token for a
// 1-hour access token, cached in memory per warm instance. This acts AS james@
// directly, so every Gmail call uses `users/me` (see gmail.ts) and resolves to
// his mailbox — no service account, no Workspace-Admin domain-wide delegation.
//
// Secrets (Supabase edge-function secrets):
//   GMAIL_OAUTH_CLIENT_ID      — OAuth 2.0 client id of the Gmail credential
//   GMAIL_OAUTH_CLIENT_SECRET  — its client secret
//   GMAIL_OAUTH_REFRESH_TOKEN  — james@'s refresh token (scope incl. gmail.modify)
//
// The granted scope includes https://mail.google.com/ + gmail.modify, which
// covers users.watch, users.history, messages/threads read, and drafts.create.
//
// NOTE: this is the SAME refresh token the n8n caching workflow uses. If that
// credential is ever revoked or re-authorized, mint the drafter its own refresh
// token (same OAuth client, one consent) and update GMAIL_OAUTH_REFRESH_TOKEN.

const TOKEN_URL = "https://oauth2.googleapis.com/token";

let cached: { token: string; exp: number } | null = null;

export async function getGmailAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const clientId = Deno.env.get("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GMAIL_OAUTH_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GMAIL_OAUTH_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_REFRESH_TOKEN",
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  cached = { token: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return cached.token;
}
