# Runbook — event-driven Gmail drafter (Pub/Sub → Supabase edge function)

Replaces the n8n 5-minute drafter. When a new email lands in James's inbox, Gmail
pushes a notification to Pub/Sub, which calls the `draft-james-reply` edge
function; it writes a reply in James's voice and leaves it as a **draft** in his
mailbox for review/send (works through delegated access).

```
Gmail inbox --users.watch--> Pub/Sub topic --push--> draft-james-reply (edge fn)
                                                          |-- history.list (what's new)
                                                          |-- threads.get  (context)
                                                          |-- james_email_samples (style)
                                                          |-- OpenAI gpt-4o (write)
                                                          '-- drafts.create (draft in mailbox)
renew-gmail-watch (edge fn) <--daily cron-- keeps the watch alive (expires <=7 days)
```

Auth to Gmail = **domain-wide delegation**: a service account impersonates
`james@myadventuregroup.com.au` with the `gmail.modify` scope. No refresh token.

---

## What I need back from you to deploy
After you finish Part A–C below, send me these and I'll set the secrets, apply
the migration, deploy both functions, wire the push subscription, and start the watch:

1. **GCP project ref / id** (e.g. `mag-gmail-drafter`)
2. **Pub/Sub topic name** — full form `projects/<proj>/topics/<topic>`
3. **Service-account client email** (e.g. `gmail-drafter@<proj>.iam.gserviceaccount.com`)
4. **Service-account private key** — the `private_key` field from the downloaded JSON
5. Confirm the **Supabase project** = MAGTestProject (`aivitcomiywiysrfwqxt`) — or tell me otherwise
6. A **shared secret** string of your choosing (or let me generate one) for the push URL

I will also need the OpenAI key available as a Supabase secret (you already have it
in `OPENAI_API_KEY.txt`; it is **not** committed).

---

## Part A — Google Cloud project + Pub/Sub  (Console: console.cloud.google.com)
1. Create (or pick) a GCP project. Note its **project id**.
2. **Enable APIs**: Gmail API, Cloud Pub/Sub API.
3. **Create a Pub/Sub topic**, e.g. `gmail-inbound`. Full name is
   `projects/<proj>/topics/gmail-inbound`.
4. **Grant Gmail permission to publish** to that topic: on the topic, add principal
   `gmail-api-push@system.gserviceaccount.com` with role **Pub/Sub Publisher**.
   (This is what lets `users.watch` publish; without it, watch fails.)
5. Leave the **push subscription** for later (Part D) — it needs the function URL.

## Part B — Service account + domain-wide delegation
1. In the same GCP project: **IAM & Admin → Service Accounts → Create**
   (e.g. `gmail-drafter`). No project roles needed.
2. On the service account, **Keys → Add key → JSON** → download. Keep the
   `client_email` and `private_key`. **Do not put this file in the repo** — its
   default name (`<proj>-<hash>.json`) is NOT matched by `.gitignore`. Either hand
   me the `private_key` value directly (it goes into a Supabase secret, not a
   file), or drop the JSON in the repo's `secrets/` folder, which *is* gitignored.
3. Note the service account's **Client ID** (a long number, under its Details).
4. **Workspace Admin console** (admin.google.com, super admin):
   **Security → Access and data control → API controls → Domain-wide delegation
   → Add new**. Client ID = the number from step 3. OAuth scope =
   `https://www.googleapis.com/auth/gmail.modify`. Authorize.
   - This is the step that lets the service account act as James. Scope is
     limited to Gmail modify only.

## Part C — pick the shared secret
Choose a long random string (the push URL token). Example to generate one:
`openssl rand -hex 24`. You'll give it to me as `PUSH_SHARED_SECRET`.

---

## Part D — deploy (I do these via Supabase MCP once you've sent the values)
1. **Apply migration** `supabase/migrations/0001_gmail_drafter_state.sql`
   (creates `gmail_watch_state`, `gmail_processed_messages`).
2. **Set secrets** on the Supabase project:
   - `GMAIL_SA_CLIENT_EMAIL`
   - `GMAIL_SA_PRIVATE_KEY`  (the JSON `private_key`, newlines as `\n` is fine)
   - `GMAIL_IMPERSONATE_USER` = `james@myadventuregroup.com.au`
   - `GMAIL_PUBSUB_TOPIC` = `projects/<proj>/topics/gmail-inbound`
   - `PUSH_SHARED_SECRET`
   - `OPENAI_API_KEY`
   (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)
3. **Deploy** `draft-james-reply` and `renew-gmail-watch` with **verify_jwt = false**
   (Pub/Sub/cron can't present a Supabase JWT; we authenticate with the token query).
4. **Create the push subscription** (Console) on topic `gmail-inbound`:
   - Delivery type **Push**, endpoint:
     `https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/draft-james-reply?token=<PUSH_SHARED_SECRET>`
   - Ack deadline ~60s. (No OIDC needed; the token in the URL is the auth.)
5. **Schedule the renewal**: run `supabase/schedule_renew_watch.sql` (fill in
   `<PROJECT_REF>` and `<PUSH_SHARED_SECRET>`).
6. **Start the watch now**: call
   `https://aivitcomiywiysrfwqxt.supabase.co/functions/v1/renew-gmail-watch?token=<PUSH_SHARED_SECRET>`
   once (POST). It registers the watch and seeds the baseline.

---

## Verify
- Send James a test email (to his inbox, primary category).
- Within seconds a **draft reply** should appear in that thread.
- Logs: Supabase → Edge Functions → `draft-james-reply` → Logs.
- `select * from gmail_watch_state;` shows a future `watch_expiration`.
- `select * from gmail_processed_messages order by processed_at desc limit 5;`
  shows handled messages with a `draft_id`.

## Retire the old n8n drafter
Once you've seen drafts appear for a day, **deactivate** the n8n 5-minute drafter
workflow so the two don't both draft. (The n8n *caching* workflow that fills
`james_email_samples` stays — this function still reads it for style.)

## Behaviour notes / knobs
- **Scope**: INBOX only; skips Promotions/Social/Updates/Forums, `no-reply`
  senders, and anything James already replied to or that already has a draft.
  To change, edit `EXCLUDE_CATEGORIES` / the filter block in
  `draft-james-reply/index.ts`.
- **One draft per thread**: the idempotency ledger + the "already handled" check
  stop repeats across Pub/Sub retries.
- **Cost**: Pub/Sub is within the free tier at this volume; the spend is one
  OpenAI gpt-4o call per qualifying inbound email.
- **Draft, never send**: the function only ever creates a draft. Nothing is sent
  automatically.
