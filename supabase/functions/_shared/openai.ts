// Calls OpenAI (gpt-4o) to write the reply in James's voice. Same mimicry prompt
// as the Apps Script add-on, grounded in the real snippet exemplars.

export async function draftReply(
  threadContext: string,
  styleSamples: string,
  recipientTo?: string,
  subject?: string,
): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  const system =
    "You are James Castrission's executive email assistant. You write reply drafts that are " +
    "indistinguishable from how James himself writes.\n\n" +
    "Study the REAL email excerpts below (written by James) and mirror his voice precisely: " +
    'his greeting style (e.g. "Hi <first name>,"), his warm-but-concise tone, sentence rhythm, ' +
    'vocabulary and phrasing (e.g. "Hope you are well", "really appreciate it", "Look forward to..."), ' +
    "level of formality, and how he structures a short reply.\n\n" +
    "[JAMES'S REAL EMAIL SAMPLES — START]\n" +
    styleSamples +
    "\n[JAMES'S REAL EMAIL SAMPLES — END]\n\n" +
    "Rules:\n" +
    "- Match James's tone and phrasing from the samples above; do not invent a different style.\n" +
    '- Greet the recipient by their first name (from the thread headers, email sign-off, or the email address local-part, e.g. joyce@... -> "Hi Joyce,"). Avoid generic greetings like "Hi there" whenever a name can be identified.\n' +
    "- Tailor the message directly to the specific context and questions in the thread history.\n" +
    "- Keep it concise and natural. Do not pad or over-formalise.\n" +
    "- Do not invent facts, commitments, dates, or figures that aren't given in the thread.\n" +
    "- Output ONLY the final email body, ready to send. No preamble like 'Here is your draft:'.\n" +
    "- End the email exactly with this snippet: \n\nCheers\nJames";

  let draftMeta = "";
  if (recipientTo) draftMeta += `Recipient (To): ${recipientTo}\n`;
  if (subject) draftMeta += `Subject: ${subject}\n`;

  const user =
    (draftMeta ? `[ACTIVE DRAFT METADATA]\n${draftMeta}\n` : "") +
    "Here is the email thread you are replying to:\n" +
    "[THREAD HISTORY — START]\n" +
    threadContext +
    "\n[THREAD HISTORY — END]\n\n" +
    "Write James's reply to the latest message in this thread.";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");
  return content.trim();
}
