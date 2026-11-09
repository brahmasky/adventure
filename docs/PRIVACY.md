# Privacy policy — Houge (PersonalAssistant)

Houge is a single-user personal assistant that runs on its owner's own computer. It is not offered to anyone else.
This policy covers the Google OAuth app "Personal Assistant Gmail" that Houge uses.

## What Houge accesses

- **Gmail, read-only** (`gmail.readonly`), for the owner's own mailbox only. Houge cannot send, delete, label or change mail.
- New mail is read as metadata: sender, subject, Gmail's short snippet, labels and the "important" flag. Message bodies
  are read only when the owner asks Houge about a specific mail, and attachments are never downloaded.

## Where the data goes

- **Stored locally** in a database on the owner's computer. Subject, snippet and sender name are cleared 30 days after
  a mail arrives (configurable); metadata such as message ids, dates and routing decisions are kept.
- **TypeSafe (Jev)**, a classification service: for each new mail, the sender, subject, snippet and labels, with
  verification codes, links and other secret-shaped text masked first. It is used only to decide whether the mail
  needs the owner's attention now.
- **Telegram**, to the owner's own chat: a short notice (sender name and masked subject) for mail that needs
  attention.
- Nothing is sold, shared with anyone else, used for advertising, or used to train models.

## Control and revocation

- `/mail off` in Houge's chat stops reading mail; `houge mail purge --yes` clears all stored mail text.
- Access can be revoked at any time at https://myaccount.google.com/permissions.

## Contact

paco.luo@gmail.com
