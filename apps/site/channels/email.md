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

New entries saved from an email link to the original in Gmail. Only someone with that email in their own mailbox can open it. The link opens in the Google account your browser uses by default, so if you are signed in to more than one, switch accounts in Gmail when it does not open.

## Set up

For the person who runs project-os.

1. [Set up the Google connector](../connectors/google.md#set-up).
2. In the same Google Cloud project, enable the **Gmail API**.
3. Add the Gmail read scope, `https://www.googleapis.com/auth/gmail.readonly`, to the consent screen.
4. Set `EMAIL_DIGEST=true` in `.env`. It is off by default because it changes what linking Google asks for: the Gmail read scope is added to Drive's.

People who linked Google before need to run `/connect provider:Google` again. Nobody's mailbox is read until they turn it on themselves. Mailboxes switched on before labels existed stay idle until a label is chosen. Other settings are in [Environment](../reference/environment.md#email-digest).
