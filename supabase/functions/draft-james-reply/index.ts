// draft-james-reply — Pub/Sub push target.
//
// Flow: Gmail users.watch publishes to a Pub/Sub topic on every INBOX change;
// Pub/Sub pushes here. We decode the notification, list what changed via
// history.list, and for each genuinely new inbound message (inbox, not a
// promo/social/update/forum, not from James, no existing reply/draft) we build
// a reply in James's voice with OpenAI and create it as a Gmail draft in his
// mailbox. The delegate then reviews/sends it from the delegated mailbox.
//
// Auth of the push request: a shared secret in the URL query (?token=...) that
// must equal PUSH_SHARED_SECRET. Deploy this function with verify_jwt = false.

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import {
  addThreadLabel,
  createDraft,
  getMessage,
  getOrCreateLabelId,
  getThread,
  header,
  listHistory,
  plainText,
  resolveLabelIds,
} from "../_shared/gmail.ts";
import { ACTION_LABEL_TOKENS } from "../_shared/labels.ts";
import { getStyleSamples } from "../_shared/samples.ts";
import { draftReply } from "../_shared/openai.ts";
import { buildReply, textToHtml } from "../_shared/mime.ts";
import { SIGNATURE_HTML } from "../_shared/signature.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const EXCLUDE_CATEGORIES = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];

// Label applied to every thread we draft into, so drafts are easy to find/audit.
// (Gmail search token: label:ai-drafts-v2.) Matched case/space-insensitively.
const DRAFT_LABEL = "AI Drafts V2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  // --- authenticate the push ------------------------------------------------
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== Deno.env.get("PUSH_SHARED_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  // --- decode the Pub/Sub envelope -----------------------------------------
  // deno-lint-ignore no-explicit-any
  let envelope: any;
  try {
    envelope = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const dataB64 = envelope?.message?.data;
  if (!dataB64) return new Response("no data", { status: 204 }); // ack & ignore

  let notif: { emailAddress: string; historyId: string | number };
  try {
    notif = JSON.parse(atob(dataB64));
  } catch {
    return new Response("bad data", { status: 204 });
  }
  const email = notif.emailAddress;
  const notifHistoryId = String(notif.historyId);

  try {
    const token = await getGmailAccessToken();

    // --- read processing baseline ------------------------------------------
    const { data: state } = await sb
      .from("gmail_watch_state")
      .select("last_history_id")
      .eq("email_address", email)
      .maybeSingle();

    // No baseline yet (first notification after a watch). We can't list history
    // without a start point, so just record this historyId and ack.
    if (!state?.last_history_id) {
      await sb.from("gmail_watch_state").upsert({
        email_address: email,
        last_history_id: notifHistoryId,
        updated_at: new Date().toISOString(),
      });
      return new Response("seeded baseline", { status: 200 });
    }

    // Which labels we draft for: INBOX plus the configured "to action" labels.
    // Resolve the label tokens to IDs once; a label that doesn't exist is just
    // skipped (not fatal).
    const { ids: actionLabelIds, missing } = await resolveLabelIds(token, ACTION_LABEL_TOKENS);
    if (missing.length) console.warn("action labels not found (skipped):", missing);
    const targetLabelIds = new Set<string>(["INBOX", ...actionLabelIds]);

    // --- what changed ------------------------------------------------------
    let added: { id: string; threadId: string }[];
    try {
      added = await listHistory(token, String(state.last_history_id), targetLabelIds);
    } catch (e) {
      // deno-lint-ignore no-explicit-any
      if ((e as any).status === 404) {
        // Baseline too old — clear it so the next watch renewal re-seeds.
        await sb.from("gmail_watch_state").update({ last_history_id: null }).eq("email_address", email);
        return new Response("history expired; re-seed needed", { status: 200 });
      }
      throw e;
    }

    let styleSamples: string | null = null;

    for (const { id, threadId } of added) {
      // Idempotency lock: insert first; PK conflict means already handled.
      const { error: lockErr } = await sb
        .from("gmail_processed_messages")
        .insert({ message_id: id, thread_id: threadId });
      if (lockErr) continue;

      try {
        const msg = await getMessage(token, id);
        const labels: string[] = msg.labelIds ?? [];

        // Scope filter: must still carry a target label (INBOX or a "to action"
        // label), never SENT, never a non-primary inbox category.
        if (!labels.some((l) => targetLabelIds.has(l))) continue;
        if (labels.includes("SENT")) continue;
        if (EXCLUDE_CATEGORIES.some((l) => labels.includes(l))) continue;

        const from = header(msg, "From");
        if (/no-?reply|do-?not-?reply/i.test(from)) continue;
        if (from.toLowerCase().includes(email.toLowerCase())) continue;

        // Thread context + skip if James already replied or a draft exists.
        const thread = await getThread(token, threadId);
        const tmsgs = thread.messages ?? [];
        // deno-lint-ignore no-explicit-any
        const alreadyHandled = tmsgs.some((m: any) => {
          const f = header(m, "From").toLowerCase();
          const l: string[] = m.labelIds ?? [];
          const jamesReplied = f.includes(email.toLowerCase()) &&
            Number(m.internalDate) > Number(msg.internalDate);
          return jamesReplied || l.includes("DRAFT");
        });
        if (alreadyHandled) continue;

        const context = tmsgs
          .slice(-4)
          // deno-lint-ignore no-explicit-any
          .map((m: any) => `From: ${header(m, "From")}\nBody: ${plainText(m)}`)
          .join("\n\n---\n\n");

        if (styleSamples === null) styleSamples = await getStyleSamples();
        const replyBody = await draftReply(context, styleSamples);

        const raw = buildReply({
          from: email,
          to: header(msg, "Reply-To") || from,
          subject: header(msg, "Subject"),
          inReplyTo: header(msg, "Message-ID"),
          references: `${header(msg, "References")} ${header(msg, "Message-ID")}`.trim(),
          // HTML body: the model's reply (ending "Cheers / James") + James's signature.
          body: `${textToHtml(replyBody)}<br><br>${SIGNATURE_HTML}`,
        });

        const draft = await createDraft(token, raw, threadId);
        await sb
          .from("gmail_processed_messages")
          .update({ draft_id: draft.id })
          .eq("message_id", id);

        // Tag the thread so AI drafts are easy to find. Non-fatal: the draft is
        // already saved, so a labeling hiccup shouldn't trigger a retry/re-draft.
        try {
          const labelId = await getOrCreateLabelId(token, DRAFT_LABEL);
          await addThreadLabel(token, threadId, labelId);
        } catch (labelErr) {
          console.error(`labeling failed for thread ${threadId}:`, labelErr);
        }
      } catch (perMsg) {
        // Release the lock so this message is retried on the next delivery.
        await sb.from("gmail_processed_messages").delete().eq("message_id", id);
        console.error(`draft failed for message ${id}:`, perMsg);
      }
    }

    // Advance the baseline only after a clean pass.
    await sb.from("gmail_watch_state").upsert({
      email_address: email,
      last_history_id: notifHistoryId,
      updated_at: new Date().toISOString(),
    });

    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("handler error:", e);
    // 500 -> Pub/Sub retries; idempotency locks prevent duplicate drafts.
    return new Response("error", { status: 500 });
  }
});
