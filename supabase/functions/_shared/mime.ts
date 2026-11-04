// Builds a base64url-encoded RFC 822 reply message for drafts.create.
// Threading is preserved by In-Reply-To / References headers plus the draft's
// message.threadId (set by the caller). The body is HTML (text/html) so James's
// HTML signature renders — see signature.ts and textToHtml() below.

// Turns the model's plain-text reply into safe HTML: escapes markup and turns
// newlines into <br>, wrapped so it reads as a normal email in Arial.
export function textToHtml(text: string): string {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#212121">` +
    esc.replace(/\r?\n/g, "<br>") +
    `</div>`;
}

export function buildReply(opts: {
  from: string;
  to: string;
  subject: string;
  inReplyTo: string;
  references: string;
  body: string; // HTML
}): string {
  const subject = /^re:/i.test(opts.subject.trim()) ? opts.subject : `Re: ${opts.subject}`;

  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${subject}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : "",
    opts.references ? `References: ${opts.references}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ]
    .filter(Boolean)
    .join("\r\n");

  const raw = `${headers}\r\n\r\n${opts.body}`;

  // base64url of the UTF-8 bytes
  const bytes = new TextEncoder().encode(raw);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
