// Extra mailbox labels (besides INBOX) whose messages should also get a drafted
// reply. Source of truth: other_labels_to_include.txt (repo root).
//
// Stored here as the Gmail `label:` search tokens exactly as given. They are
// resolved to the user's real label IDs at runtime (see resolveLabelIds in
// gmail.ts) using separator-insensitive matching, so differences in case,
// spacing, nesting ("/"), and punctuation between the token and the actual
// label name don't matter — e.g. the token "@-james-to-action-priority--<24hrs-"
// resolves to a label named "@ James To Action/Priority (<24hrs)".
export const ACTION_LABEL_TOKENS = [
  "@-va-to-action",
  "@-va-to-action-cara-to-action",
  "@-va-to-action-eyo-to-action",
  "@-james-to-action",
  "@-james-to-action--personal-",
  "@-james-to-action-priority--<24hrs-",
];
