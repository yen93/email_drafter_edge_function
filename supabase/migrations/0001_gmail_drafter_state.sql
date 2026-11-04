-- State tables for the event-driven Gmail drafter (draft-james-reply /
-- renew-gmail-watch edge functions). Only the service_role (the edge functions)
-- touches these; RLS is ON with no policies, so anon/authenticated get nothing
-- and service_role bypasses RLS.

-- Processing position + current watch expiry, one row per watched mailbox.
create table if not exists public.gmail_watch_state (
  email_address   text primary key,
  last_history_id text,                       -- Gmail historyId we've processed up to
  watch_expiration timestamptz,               -- when the current users.watch lapses
  updated_at      timestamptz not null default now()
);

-- Idempotency ledger: one row per Gmail message we've acted on, so duplicate /
-- retried Pub/Sub deliveries never produce a second draft.
create table if not exists public.gmail_processed_messages (
  message_id   text primary key,              -- Gmail message id
  thread_id    text,
  draft_id     text,                          -- the draft we created (null until done)
  processed_at timestamptz not null default now()
);

create index if not exists gmail_processed_messages_processed_at_idx
  on public.gmail_processed_messages (processed_at);

alter table public.gmail_watch_state        enable row level security;
alter table public.gmail_processed_messages enable row level security;
