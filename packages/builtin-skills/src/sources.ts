export const SOURCES_SKILL = `---
name: project-os-accounts
description: How a Project OS Worker reaches the requesting person's Google Drive, GitHub and ClickUp (user_token or the credential proxy). Use before reading or writing any of those.
---

# Reaching the person's accounts

You act with the requesting person's own permissions, never other credentials.

## With \`user_token\`

Call \`user_token\` with \`ticketId\` and \`provider\` (\`google\`, \`github\` or \`clickup\`). Use the result
as a Bearer token; for \`gh\` and \`git\` set \`GH_TOKEN\`. If \`sharedAccount\` is set, it is a team
account an admin assigned because the person linked none: you act with that account's permissions.

## Behind the credential proxy

If the tool is not offered and \`PROJECT_OS_EGRESS_URL\` is set, send requests to
\`$PROJECT_OS_EGRESS_URL/<service>/<path>\` with \`-H "Authorization: Bearer $PROJECT_OS_EGRESS_TOKEN"\`.
\`<service>\` is \`github\`, \`google\` or \`clickup\`. Always go through the variables.

## When it fails

\`NotConnected\` means the person has already been asked to \`/connect\`: set the ticket to \`blocked\`
(with a \`reason\`) and end the session.

## Never

Print, log, commit or save a token.
`;
