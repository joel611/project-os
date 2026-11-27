# ClickUp

Connect ClickUp to share files that are too big for Discord, such as long videos.

## Share a large file

1. Attach the file to a ClickUp task.
2. Paste the task link in Discord with your question.
3. The worker downloads the file with your ClickUp access.

Small files, such as images, can go straight into Discord.

## Access

Run `/connect` and choose ClickUp, then pick the workspaces to share. ClickUp does not offer read-only or limited permissions: the linked account's token follows that account's access in those workspaces.

## Set up

ClickUp is optional. For the person who runs project-os. Values go into `.env`.

Discord caps an upload at 25 MB, so a PM sends a big video through ClickUp: they attach it to a ClickUp task, paste the task link in Discord, and the Worker downloads it with that PM's own ClickUp token (read access follows their workspace permissions). Images and other small files go straight in Discord and need no ClickUp.

1. In ClickUp, open the avatar menu → **Settings → Apps → Create new app**.
2. Set the **Redirect URL** to `<PUBLIC_URL>/api/auth/callback/clickup`, e.g. `http://localhost:8080/api/auth/callback/clickup`.
3. Copy the **Client ID** and **Client Secret**:

   ```sh
   CLICKUP_CLIENT_ID=...
   CLICKUP_CLIENT_SECRET=...
   ```

People link it with `/connect provider:ClickUp`. During authorization ClickUp asks them to pick the workspace(s) the app can reach. ClickUp has no scopes.

Then [turn on account linking](../guide/setup.md#turn-on-account-linking).
