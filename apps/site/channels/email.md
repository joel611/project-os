# Email

Email adds knowledge to your projects. project-os reads new Gmail messages and saves the decisions and facts to Project Memory.

Email is read only. You cannot ask questions by email, and project-os never sends, labels, or changes mail.

## Turn it on

It is off until the person running project-os enables it. After that, each person chooses for their own mailbox:

1. Run `/connect` in Discord and choose Google. If you linked Google before email was enabled, link it again.
2. Open the **Email** page in the dashboard and turn on your mailbox.
3. Choose what to read: your whole inbox, or one Gmail label. Nothing is read until you choose.

When reading the whole inbox, promotions, social, spam, and sent mail are skipped.

## What happens to an email

1. Quoted replies are removed. Secrets, one-time codes, card and phone numbers, link query strings, and the address part of email addresses are masked.
2. The classifier matches the email to a project.
3. If it is at least 90% sure, the decisions and facts are saved to Project Memory with the sender, subject, and a redacted quote. The email body is then deleted.
4. If it is less sure, the email waits on the **Email** page for you to pick a project or dismiss it. Your choice helps it match similar emails later. Waiting emails are dropped after 30 days.

## Set up

To enable email for your team, see [Email Digest settings](../guide/setup.md#email-digest).
