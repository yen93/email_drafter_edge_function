// Thin Gmail REST helpers (all act as the impersonated user "me").

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailHeader {
  name: string;
  value: string;
}

async function gfetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gmail ${path} -> ${res.status} ${text}`);
    // deno-lint-ignore no-explicit-any
    (err as any).status = res.status;
    throw err;
  }
  return res.json();
}

// Returns de-duplicated {id, threadId} for messages that became relevant since
// startHistoryId, where "relevant" means they carry one of `targetLabelIds`
// (e.g. INBOX plus the configured "to action" labels). We pick up both:
//   * messageAdded — a new message that arrived already carrying a target label,
//   * labelAdded   — an existing message that was just tagged with a target label
//                    (e.g. a VA dragging a thread into "@ James To Action").
// Filtering happens on the history stub's labelIds, so non-target changes never
// cost an extra fetch. Throws with .status === 404 if startHistoryId is too old
// (caller should re-seed via a fresh watch).
export async function listHistory(
  token: string,
  startHistoryId: string,
  targetLabelIds: Set<string>,
): Promise<{ id: string; threadId: string }[]> {
  const added: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ startHistoryId });
    qs.append("historyTypes", "messageAdded");
    qs.append("historyTypes", "labelAdded");
    if (pageToken) qs.set("pageToken", pageToken);
    const data = await gfetch(token, `/history?${qs}`);
    for (const h of data.history ?? []) {
      // New messages that already carry a target label.
      for (const m of h.messagesAdded ?? []) {
        const msg = m.message;
        if (msg && (msg.labelIds ?? []).some((l: string) => targetLabelIds.has(l))) {
          added.push({ id: msg.id, threadId: msg.threadId });
        }
      }
      // Messages a target label was just ADDED to (the added labels are in
      // la.labelIds; la.message is the message it was applied to).
      for (const la of h.labelsAdded ?? []) {
        if ((la.labelIds ?? []).some((l: string) => targetLabelIds.has(l)) && la.message) {
          added.push({ id: la.message.id, threadId: la.message.threadId });
        }
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return [...new Map(added.map((m) => [m.id, m])).values()];
}

export const getMessage = (token: string, id: string) =>
  gfetch(token, `/messages/${id}?format=full`);

export const getThread = (token: string, id: string) =>
  gfetch(token, `/threads/${id}?format=full`);

export const createDraft = (token: string, raw: string, threadId: string) =>
  gfetch(token, `/drafts`, { method: "POST", body: JSON.stringify({ message: { raw, threadId } }) });

// (Re)starts the mailbox watch -> returns { historyId, expiration(ms string) }.
// labelIds selects which labels Gmail pushes notifications for (INCLUDE = notify
// when a message has ANY of them). Defaults to INBOX only.
export const startWatch = (
  token: string,
  topicName: string,
  labelIds: string[] = ["INBOX"],
) =>
  gfetch(token, `/watch`, {
    method: "POST",
    body: JSON.stringify({ topicName, labelIds, labelFilterBehavior: "INCLUDE" }),
  });

// List all of the mailbox's labels.
export const listLabels = (token: string) => gfetch(token, `/labels`);

// Separator-insensitive label-name key: lowercase, collapse every run of
// non-alphanumeric (except "@") into a single "-", and trim leading/trailing
// "-". So "@ James To Action/Priority (<24hrs)" and the search token
// "@-james-to-action-priority--<24hrs-" both key to the same string.
const labelKey = (s: string) =>
  s.toLowerCase().replace(/^label:/, "").replace(/[^a-z0-9@]+/g, "-").replace(/^-+|-+$/g, "");

// Resolve Gmail `label:` search tokens to the user's actual label IDs. Tokens
// that match no existing label are returned in `missing` (for logging) rather
// than failing — a label that isn't there simply isn't watched/processed.
export async function resolveLabelIds(
  token: string,
  tokens: string[],
): Promise<{ ids: string[]; missing: string[] }> {
  const data = await listLabels(token);
  const byKey = new Map<string, string>();
  // deno-lint-ignore no-explicit-any
  for (const l of (data.labels ?? []) as any[]) byKey.set(labelKey(l.name), l.id);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const t of tokens) {
    const id = byKey.get(labelKey(t));
    if (id) ids.push(id);
    else missing.push(t);
  }
  return { ids, missing };
}

// Resolve a user label id by name, creating the label only if truly absent.
// Matching uses Gmail's own normalization (case-insensitive, spaces/hyphens
// equivalent) so "ai-drafts-v2" resolves to an existing "AI Drafts V2" label.
// Creation is still guarded: Gmail 409s on a conflicting name, so on 409 we
// re-list and match rather than fail.
const normLabel = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "-");

export async function getOrCreateLabelId(token: string, name: string): Promise<string> {
  const want = normLabel(name);
  const find = async (): Promise<string | undefined> => {
    const data = await gfetch(token, `/labels`);
    // deno-lint-ignore no-explicit-any
    return (data.labels ?? []).find((l: any) => normLabel(l.name) === want)?.id;
  };

  const existing = await find();
  if (existing) return existing;

  try {
    const created = await gfetch(token, `/labels`, {
      method: "POST",
      body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
    });
    return created.id;
  } catch (e) {
    // 409 = a conflicting label already exists (different case/spacing) — re-find it.
    // deno-lint-ignore no-explicit-any
    if ((e as any).status === 409) {
      const again = await find();
      if (again) return again;
    }
    throw e;
  }
}

// Add a label to a whole thread.
export const addThreadLabel = (token: string, threadId: string, labelId: string) =>
  gfetch(token, `/threads/${threadId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: [labelId] }),
  });

// deno-lint-ignore no-explicit-any
export function header(msg: any, name: string): string {
  const h = (msg.payload?.headers ?? []).find(
    (x: GmailHeader) => x.name.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

// Flatten a message's text/plain parts into a single decoded string.
// deno-lint-ignore no-explicit-any
export function plainText(msg: any): string {
  const parts: string[] = [];
  // deno-lint-ignore no-explicit-any
  const walk = (p: any) => {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) parts.push(decodeB64Url(p.body.data));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(msg.payload);
  if (!parts.length && msg.payload?.body?.data) parts.push(decodeB64Url(msg.payload.body.data));
  return parts.join("\n").trim();
}

function decodeB64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
