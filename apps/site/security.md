# Security

This page explains how Project OS handles sensitive data and account access, and where the limits are.

## Sensitive data in email

Before an email body is stored or sent to an AI model, Project OS removes quoted replies and masks:

- passwords, keys, access tokens, and one-time codes
- card, phone, and account numbers
- the extra parameters on links, which often carry sign-in or tracking secrets
- the part of an email address before the `@`, when it appears in the body

Masking matches known patterns, so it can miss sensitive text written in an unusual way. It does not hide names, prices, contract terms, or other business content.

The **subject line and the sender's name and address are not masked**. Discord messages are not masked before they are digested.

## Your email stays yours

- Email is off until the person running Project OS enables it. Then each person turns on their own mailbox and chooses what it reads.
- Access to Gmail is read only. The email digest never sends, labels, or changes mail.
- An email still waiting for a project appears only to the owner of the mailbox. It is dropped after 30 days.
- Once an email is filed under a project or dismissed, Project OS deletes its copy of the body. The original stays in your Gmail.

**What becomes shared:** when an email is filed under a project, its memory points, sender, subject, and a masked quote become part of that project's memory. Anyone whose question draws on that memory may learn what it says. If an inbox holds confidential mail, read only one Gmail label and apply it only to mail the project may know about.

## Account access

Connected sources can be reached in two ways.

| Option                | How it works                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| **Your own account**  | Run `/connect`. Work on your question uses your access, so the provider's own permissions apply.     |
| **Shared credential** | An admin assigns a team account to a person. It is used only if that person has not linked their own. |

A person using a shared credential can reach what **that account** can reach, which may be more than they could on their own. Give it only the access every assigned person is allowed to have, and make it read only:

- **Google Drive:** Project OS asks for read-only access.
- **GitHub:** access follows the GitHub App's permissions. Keep them all read only.
- **ClickUp:** ClickUp offers no read-only access. Use a ClickUp account that is itself limited.

If [email](channels/email.md) is enabled, linking Google also grants read access to Gmail. Do not use a mailbox with private mail as a shared Google account.

## Whose permission applies

Work on a ticket uses the access of the person who wrote its latest request or follow-up. If someone else follows up, their access applies from then on. For example, a junior team member's request does not use a manager's account.

This controls what can be **fetched**, not who can **read the answer**. Answers are posted in the project's channel, where everyone in the channel can see them. Anything saved to project memory is shared with the project too. If your question could return something that not everyone there should see, do not ask it in that channel.

## Workers and tokens

- A [local computer](workers/local.md) worker receives the requester's access token so it can do the research. Only use computers you trust.
- A [cloud sandbox](workers/cloud-sandbox.md) also receives the token by default, which means the AI model can see it. Turn on the [credential proxy](workers/cloud-sandbox.md#credential-proxy) to keep the token out of the sandbox and the model.
- Dashboard admins can open the record of every worker session, including what the worker read. A requester can see the sessions for their own tickets. Common secret formats are masked in these records.
