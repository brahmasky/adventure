import type { ChoiceQuestion } from "./types.js";
/** Spec 2026-11-09 §3.5: escape first (jev-1.13 leans to the first option). */
export const MAIL_URGENCY: ChoiceQuestion = {
  id: "mail_urgency", type: "choice",
  instructions: "Houge is Paco's assistant. The state describes one email that just arrived in Paco's inbox: the sender's name and address, whether Paco has written to this sender before (`known_sender`), the subject, Gmail's short snippet, Gmail labels and whether Gmail marked it important. Codes and links are masked. Should Houge interrupt Paco about this email now, or can it wait until he looks?",
  criteria: [
    ["later", "It can wait until Paco looks: newsletters, receipts, notifications, marketing, automated updates."],
    ["now", "Paco must see or act on this within hours: a person writing to him, a deadline today, a security or money alert about his own accounts, a reply he is waiting for."]
  ]
};
export const MAIL_KIND: ChoiceQuestion = {
  id: "mail_kind", type: "choice",
  instructions: "Houge is Paco's assistant. The state describes one email in Paco's inbox (sender, subject, snippet, labels; codes and links masked). What kind of email is it?",
  criteria: [
    ["fyi", "Information for Paco; nothing to do."],
    ["action", "Paco needs to do or answer something."],
    ["risk", "A security, money or account warning about Paco's own accounts."],
    ["noise", "Marketing, newsletters or automated mail of no consequence."]
  ]
};
