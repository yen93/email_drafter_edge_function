// Pulls James's recent email snippets from the james_email_samples table and
// formats them as style exemplars for the model. Mirrors the Apps Script add-on's
// getStyleSamplesFromDB(): prefers SENT over DRAFT, strips the signature block,
// feeds up to 24 exemplars. Reads with the service_role key (bypasses RLS).

const FETCH_LIMIT = 40;
const USE_LIMIT = 24;

const FALLBACK =
  "No style samples available. Write in a warm, concise, professional Australian business tone.";

export async function getStyleSamples(): Promise<string> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return FALLBACK;

  const url =
    `${base}/rest/v1/james_email_samples` +
    `?select=Subject,snippet,labels,received_at&order=received_at.desc.nullslast&limit=${FETCH_LIMIT}`;

  let rows: Array<Record<string, unknown>>;
  try {
    const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) return FALLBACK;
    rows = await res.json();
  } catch {
    return FALLBACK;
  }
  if (!rows?.length) return FALLBACK;

  const sent: Array<Record<string, unknown>> = [];
  const other: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    // deno-lint-ignore no-explicit-any
    const isSent = ((r.labels as any[]) ?? []).some((l) => l && l.id === "SENT");
    (isSent ? sent : other).push(r);
  }

  const ordered = [...sent, ...other].slice(0, USE_LIMIT);
  const exemplars = ordered
    .map((r, i) => {
      const body = cleanSnippet((r.snippet as string) ?? "");
      if (!body) return "";
      const subj = ((r.Subject as string) ?? "(no subject)").trim();
      return `Example ${i + 1} — Subject: "${subj}"\n${body}`;
    })
    .filter(Boolean);

  return exemplars.length ? exemplars.join("\n\n") : FALLBACK;
}

function cleanSnippet(snippet: string): string {
  const s = snippet.replace(/\s+/g, " ").trim();
  return s.replace(/James Castrission\s+International Keynote Speaker[\s\S]*$/i, "").trim();
}
