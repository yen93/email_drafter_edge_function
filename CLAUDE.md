# CLAUDE.md — email_drafter_edge_function

Working notes for a future Claude session. For a current-state inventory see
`as_built.txt`; for the full setup procedure see `RUNBOOK-gmail-drafter.md`; for
session history see `chat_history/`.

## What this project is
An **event-driven Gmail reply drafter** built as Supabase edge functions. It
replaces an older n8n workflow that drafted replies on a 5-minute schedule. When
a new email hits James Castrission's inbox, Gmail push (`users.watch`) → Google
Cloud Pub/Sub → the `draft-james-reply` edge function, which writes a reply in
James's voice with OpenAI gpt-4o and leaves it as a **Gmail draft** (never sends).

It was split out of the sibling repo `email_drafter_gmail_plugin_v2` (the Gmail
add-on + n8n caching). This folder is its own project; that repo still holds the
add-on and the n8n **caching** workflow that fills `james_email_samples`.

### Why edge functions and not the add-on
A Gmail Workspace Add-on cannot appear inside a **delegated** mailbox — verified
limitation. A server-created **draft**, by contrast, is mailbox data a delegate
can see and send. That's the whole reason this exists: drafts show up for whoever
works James's mailbox via delegation.

## Architecture
```
Gmail inbox --users.watch--> Pub/Sub topic --push--> draft-james-reply (edge fn)
   |-- history.list  (new/newly-labelled msgs in INBOX + action labels, since baseline)
   |-- messages.get / threads.get  (filter + thread context)
   |-- james_email_samples  (style exemplars, service-role read)
   |-- OpenAI gpt-4o  (write reply)
   |-- drafts.create  (text/html draft + James's HTML signature)
   '-- threads.modify (label the thread "AI Drafts V2")
renew-gmail-watch (edge fn) <--daily pg_cron-- re-arm watch over INBOX + action labels
                                               (expires <=7 days)
```

## Layout
- `supabase/functions/draft-james-reply/index.ts` — Pub/Sub push handler.
- `supabase/functions/renew-gmail-watch/index.ts` — daily watch renewal.
- `supabase/functions/_shared/` — `google-auth.ts`, `gmail.ts`, `samples.ts`,
  `openai.ts`, `mime.ts`, `signature.ts`, `labels.ts` (imported by both functions via
  relative paths). `signature.ts` holds James's HTML signature (source: `e_sig.txt`);
  `labels.ts` holds `ACTION_LABEL_TOKENS` — the extra labels processed besides INBOX
  (source: `other_labels_to_include.txt`).
- `supabase/migrations/0001_gmail_drafter_state.sql` — state tables.
- `supabase/schedule_renew_watch.sql` — pg_cron template (fill in ref + secret).
- `RUNBOOK-gmail-drafter.md` — the deployment procedure.

## Key decisions & gotchas (non-obvious)
- **Auth = OAuth refresh token (NOT domain-wide delegation).** We couldn't get
  Workspace super-admin to authorize a DWD scope, so `_shared/google-auth.ts`
  exchanges a long-lived refresh token for an access token and acts AS james@
  directly (Gmail calls use `users/me`). The OAuth client + refresh token are
  **reused from the n8n "Gmail account" credential** (encrypted in the n8n Supabase
  DB `uwsncuowtzydylfabikj`); the client lives in GCP project
  `n8nautomations-498202`; granted scope includes `https://mail.google.com/` +
  `gmail.modify`. Secrets: `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` /
  `GMAIL_OAUTH_REFRESH_TOKEN`. **This refresh token is SHARED with the n8n caching
  workflow** — if it's revoked/re-authed, both break; mint the drafter its own
  (same OAuth client, one consent) when James is available. `GMAIL_IMPERSONATE_USER`
  survives but is now only the mailbox id / `gmail_watch_state` key, not an
  impersonation subject. (The old DWD/service-account JWT code is gone; the RUNBOOK's
  auth section is superseded.)
- **The Pub/Sub topic MUST live in the OAuth client's project** (`n8nautomations-498202`),
  NOT wherever else. Gmail `users.watch` rejects any other topic with
  `400 Invalid topicName does not match projects/<client-project>/topics/*`. Topic =
  `projects/n8nautomations-498202/topics/gmail-inbound`, subscription
  `gmail-inbound-push` → the `draft-james-reply` URL, publisher grant to
  `gmail-api-push@system.gserviceaccount.com` on that topic.
- **history.list is EVENTUALLY CONSISTENT — latent skip bug.** The handler advances
  `last_history_id` to the *notification's* historyId after each pass. A `messageAdded`
  event Gmail hasn't surfaced yet can be leapfrogged by a later notification and then
  **silently skipped forever** (hit this in testing). Not yet fixed — harden the
  baseline-advance (advance conservatively / periodic re-scan; the ledger makes
  re-scans safe) before trusting it for every email.
- **Drafts are `text/html`** (so James's HTML signature renders). `_shared/mime.ts`
  `buildReply` emits `text/html`; `textToHtml()` escapes the model's text and turns
  newlines into `<br>`; `index.ts` appends `SIGNATURE_HTML` after "Cheers / James".
- **Thread label "AI Drafts V2".** `getOrCreateLabelId` matches by Gmail's normalized
  form (case- and space/hyphen-insensitive, so `label:ai-drafts-v2` == "AI Drafts V2")
  and falls back on a `409` instead of trying to recreate an existing label. Labeling
  is non-fatal (the draft is already saved; a label hiccup must not trigger a re-draft).
- **OpenAI key:** the authoritative key is in **GCP Secret Manager** (project
  `claudegwscli-502400`, secret `OPENAI_API_KEY`, `sk-proj…`). The sibling repo's
  `email_drafter_gmail_plugin_v2/OPENAI_API_KEY.txt` is **stale/invalid** (`FaJo-…`)
  — do not use it.
- **Deploy with the Supabase CLI** (`npx supabase functions deploy <name>
  --project-ref aivitcomiywiysrfwqxt --no-verify-jwt --yes`) — it bundles `_shared`
  from disk, which the MCP deploy can't do cleanly for large files like the signature.
  ⚠️ **But the CLI is BLOCKED on the current Windows machine** (2026-11-06): a Windows
  Application Control (WDAC/AppLocker) policy refuses to run the CLI binary
  (`@supabase/cli-windows-x64` `supabase.exe`) — "An Application Control policy has
  blocked this file", surfacing as `spawn UNKNOWN` / errno -4094 from `npx supabase`.
  Can't be bypassed. **Deploy via the Supabase MCP `deploy_edge_function` tool
  instead:** call `get_edge_function` to pull the current file set + naming, then
  redeploy the entrypoint + ALL `_shared` files in one call (MCP deploy doesn't
  bundle from disk, so every imported file must be passed), `verify_jwt: false`,
  file names matching the deployed form (`functions/draft-james-reply/index.ts`,
  `functions/_shared/*.ts`). The whole function is ~31 KB (signature.ts ~6.3 KB) —
  comfortably within MCP limits, so the "large files" caveat above doesn't bite here.
- **Deploy both functions with `verify_jwt = false`.** They're called by Pub/Sub
  and cron, which can't present a Supabase JWT. They authenticate themselves via a
  shared secret in the URL query (`?token=PUSH_SHARED_SECRET`). Do NOT leave the
  default verify_jwt = true, or every push gets 401.
- **`users.watch` expires in ≤7 days.** `renew-gmail-watch` must run on a daily
  cron, or the push silently stops. It seeds `last_history_id` only on first run;
  renewals must NOT reset it (that would skip mail).
- **The push payload carries only `{emailAddress, historyId}`**, not the email.
  The function calls `history.list(startHistoryId = stored baseline)` to find new
  messages. If the baseline is too old, Gmail returns **404** — the code clears
  the baseline so the next watch renewal re-seeds it.
- **Idempotency:** `gmail_processed_messages` (message_id PK) is inserted BEFORE
  drafting as a lock; on a per-message failure the row is deleted so it retries.
  The handler returns 500 on a hard error so Pub/Sub retries — duplicates are
  prevented by the ledger, not by avoiding retries.
- **Draft scope = INBOX + six "to action" labels** (not INBOX-only). The extra
  labels live in `_shared/labels.ts` (`ACTION_LABEL_TOKENS`, sourced from
  `other_labels_to_include.txt`); they're stored as Gmail `label:` search tokens and
  resolved to real label IDs at runtime by `resolveLabelIds` in `gmail.ts`, which
  matches **separator-insensitively** (lowercase, collapse every non-`[a-z0-9@]` run
  to `-`, trim) so case/spacing/nesting(`/`)/punctuation don't matter — e.g. the token
  `@-james-to-action-priority--<24hrs-` resolves to a label like
  `@ James To Action/Priority (<24hrs)`. A message qualifies if it carries ANY target
  label. **`listHistory` reacts to both `messageAdded` AND `labelAdded`** — so a draft
  is created both when new mail arrives already carrying a target label and when a
  target label is *later applied* to an existing message (a VA triaging into
  "@ James To Action"). `renew-gmail-watch` must arm `users.watch` over INBOX + these
  labels (it does, with an INBOX-only fallback) or non-INBOX labels won't push. To
  change the set, edit `_shared/labels.ts` and redeploy BOTH functions, then re-arm
  the watch (the daily cron does this automatically on its next run).
- **Draft scope filter** lives in `draft-james-reply/index.ts`
  (`EXCLUDE_CATEGORIES` + the filter block): must carry a target label (INBOX or an
  action label), skip Promotions/Social/Updates/Forums, no-reply senders, self,
  **internal colleagues** (From contains `@myadventuregroup.com.au` —
  `INTERNAL_SENDER_DOMAIN`, added 2026-11-06 at James's request: no auto-draft for
  intra-MAG mail; matches the raw From header case-insensitively, so it won't catch a
  colleague writing from a non-MAG address), and already-handled threads. The already-handled check (James replied OR the thread has
  a `DRAFT`) means **existing drafts are never modified/deleted — the function only
  ever creates**, and it only acts on activity *after* the baseline (never the
  existing backlog in those labels).
- **Style samples** come from `public.james_email_samples` in the SAME Supabase
  project (MAGTestProject, `aivitcomiywiysrfwqxt`). Only `snippet` (~200 chars)
  exists per email — no full bodies — so mimicry is tone-level, same ceiling as
  the add-on. Read with the service-role key (bypasses RLS).

## Secrets
Set as Supabase edge-function secrets (see `as_built.txt` for the full list);
**never commit them**. Set them programmatically via the Supabase Management API
(`POST /v1/projects/<ref>/secrets`, bearer = `SUPABASE_ACCESS_TOKEN`) — the MCP
secret tool only prompts for manual dashboard entry. ⚠️ Two **live-credential files
sit in the repo root** and were NOT matched by the original `.gitignore`:
`service_account_json_key_claudegwscli.txt` (a service-account private key) and
`SUPABASE_ACCESS_TOKEN.txt` (the Supabase management token). Patterns were added so
they're ignored now — keep them out of any commit (better: move into `secrets/`).

## Deploy / run
**DEPLOYED and LIVE** on MAGTestProject (`aivitcomiywiysrfwqxt`) as of 2026-11-04:
migration applied, both functions deployed (`verify_jwt=false`), 7 secrets set,
Pub/Sub topic+subscription in `n8nautomations-498202`, watch armed, daily renewal
cron (`renew-gmail-watch-daily`, 02:00 UTC) scheduled, verified end-to-end (a signed
HTML draft was produced and the thread labelled). **Remaining cut-over step:**
deactivate the old n8n 5-minute drafter (keep the n8n *caching* workflow). The
`RUNBOOK` is still useful for the GCP/Pub/Sub/deploy mechanics, but its auth section
(domain-wide delegation) is superseded by the OAuth refresh-token flow above.

## Conventions
- This folder is not a git repo yet; the user handles all git/GitHub. `/dcp` here
  documents (chat_history, as_built, CLAUDE.md, .gitignore) but runs no git.
- Target Supabase project deliberately = MAGTestProject (`aivitcomiywiysrfwqxt`).
