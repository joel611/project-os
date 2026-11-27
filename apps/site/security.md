# Security

This page explains how Project OS handles sensitive data and account access.

::: info Target design
This page describes where Project OS is heading, and some of it is not built yet. See [Limitations](#limitations) for how it works today.
:::

## Sensitive data is redacted

Sensitive data is redacted before anything is sent to an AI model, including:

- passwords, keys, access tokens, and one-time codes
- card, phone, and account numbers
- sign-in and tracking secrets in links
- email addresses written inside a message

## Your email stays yours

- Email is off until the person running Project OS enables it. Then each person turns on their own mailbox and chooses what it reads.
- Access to Gmail is read only. Project OS never sends, labels, or changes mail.
- An email still waiting for a project appears only to the owner of the mailbox.
- Once an email is filed or dismissed, Project OS deletes its copy of the body. The original stays in your Gmail.
- A memory point from email keeps a Gmail link to the original. The link opens the email only for someone signed in to a mailbox that has it. For example, a manager can open their own original email, while a junior team member who does not have that email cannot.

## Account access

You can connect sources in two ways.

| Option                          | How it works                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Your own account**            | Run `/connect`. Work on your question uses your access, so the provider's own permissions apply.      |
| **Read-only shared credential** | An admin assigns a team account to a person. It is used only if that person has not linked their own. |

A person using a shared credential can reach what that account can reach. Give it only the access that every assigned person is allowed to have.

## Your permissions stay with you

The agent keeps each person's own permissions:

- Work on a ticket uses the access of the person who wrote its latest request or follow-up. A junior team member's request does not use a manager's account.
- Only the owner of an email can read the original.
- Sensitive information does not pass to people who are not allowed to see it. If a manager asks about it in a Discord channel, the agent does not repeat it there. It points the manager to the original email, which they open in Gmail.

## Workers and tokens

- A [local computer](workers/local.md) worker receives the requester's access token so it can do the research. Only use computers you trust.
- A [cloud sandbox](workers/cloud-sandbox.md) can use the [credential proxy](workers/cloud-sandbox.md#credential-proxy), which keeps the token out of the sandbox and the AI model.
- Dashboard admins can open the record of every worker session. A requester can see the sessions for their own tickets.

## Limitations

This is how Project OS works today, where it differs from the design above. Check these before you connect sensitive data.

### Memory

- A memory point is a headline plus one to three sentences, not yet a single sentence.
- A point from email keeps the sender, subject, date received, and a masked quote. It does **not** have a Gmail link yet.
- A point from Discord keeps up to three source messages. A point saved by a worker has no root message. It is linked to a ticket when there is one.

### Redaction

- Only **email bodies** are masked. The subject line, the sender's name and address, and Discord messages are **not** masked before they reach an AI model.
- Masking matches known patterns, so it can miss sensitive text written in an unusual way. It does not hide names, prices, contract terms, or other business content.

### Permissions and sharing

- **The agent does not yet detect sensitive answers or point back to the original email.** Answers are posted in the project's channel, where everyone in the channel can read them, even when they were fetched with a manager's access. Do not ask in a channel for anything that not everyone there should see.
- When an email is filed under a project, its memory points, sender, subject, and masked quote become shared project memory. If your inbox holds confidential mail, read only one Gmail label and apply it only to mail the whole project may know about.
- Permission follows the latest follow-up. If someone else follows up on a ticket, their access applies from then on.
- Dashboard admins can see what a worker read in its session record. Only common secret formats are masked there.

### Accounts and tokens

- A shared credential may reach more than the person using it could on their own.
- Read-only is not enforced for every provider. Google Drive access is read only. GitHub follows the GitHub App's permissions, so keep them all read only. ClickUp offers no read-only access, so use a ClickUp account that is itself limited.
- If [email](channels/email.md) is enabled, linking Google also grants read access to Gmail. Do not use a mailbox with private mail as a shared Google account.
- The credential proxy is off by default. Without it, a cloud sandbox receives the requester's token, and the AI model can see it.
- Emails waiting for a project are dropped after 30 days.
