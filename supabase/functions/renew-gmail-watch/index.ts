// renew-gmail-watch — (re)starts the Gmail mailbox watch.
//
// A Gmail users.watch registration expires after <= 7 days, so this is called on
// a daily schedule (Supabase cron -> see migrations) to keep the push flowing.
// It also seeds the processing baseline (last_history_id) on the very first run.
//
// Auth: shared secret in the URL query (?token=...). Deploy with verify_jwt=false.

import { getGmailAccessToken } from "../_shared/google-auth.ts";
import { resolveLabelIds, startWatch } from "../_shared/gmail.ts";
import { ACTION_LABEL_TOKENS } from "../_shared/labels.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== Deno.env.get("PUSH_SHARED_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  const email = Deno.env.get("GMAIL_IMPERSONATE_USER");
  const topic = Deno.env.get("GMAIL_PUBSUB_TOPIC"); // projects/<proj>/topics/<topic>
  if (!email || !topic) {
    return new Response("missing GMAIL_IMPERSONATE_USER / GMAIL_PUBSUB_TOPIC", { status: 500 });
  }

  try {
    const token = await getGmailAccessToken();

    // Watch INBOX plus the configured "to action" labels. If label resolution
    // fails for any reason, fall back to watching INBOX so renewal still works.
    let watchLabels = ["INBOX"];
    try {
      const { ids, missing } = await resolveLabelIds(token, ACTION_LABEL_TOKENS);
      if (missing.length) console.warn("action labels not found (skipped):", missing);
      watchLabels = ["INBOX", ...ids];
    } catch (le) {
      console.error("label resolution failed; watching INBOX only:", le);
    }

    const res = await startWatch(token, topic, watchLabels); // { historyId, expiration }

    // Keep an existing processing position; only seed it on the first ever run.
    const { data: existing } = await sb
      .from("gmail_watch_state")
      .select("last_history_id")
      .eq("email_address", email)
      .maybeSingle();

    await sb.from("gmail_watch_state").upsert({
      email_address: email,
      last_history_id: existing?.last_history_id ?? String(res.historyId),
      watch_expiration: new Date(Number(res.expiration)).toISOString(),
      updated_at: new Date().toISOString(),
    });

    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("watch renewal failed:", e);
    return new Response(`error: ${e}`, { status: 500 });
  }
});
