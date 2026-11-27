# Google

Connect Google so project-os can use the documents your team keeps in Google Drive.

## What you can do

- **Add a Drive folder as a project source** with `/source-add`.
- **List files** in Drive with a quick question.
- **Research your documents.** Workers can read Drive files while they work on a ticket.

## Access

Run `/connect` and choose Google. Drive access is read only, and limited to what the linked account can already see.

Your Google account also lets you see your tickets on the dashboard. If your team enables it, you can also let project-os [read your email](../channels/email.md).

## Set up

For the person who runs project-os. Values go into `.env`.

This lets each person run `/connect provider:Google` and link their own Google account. The Coordinator asks Google for these scopes (`packages/auth/src/connections.ts`):

| Scope                                            | Why                                                           |
| ------------------------------------------------ | ------------------------------------------------------------- |
| `openid`, `email`, `profile`                     | Show who linked the account                                   |
| `https://www.googleapis.com/auth/drive.readonly` | Read Drive files the person can already see. No write access. |

It also asks for offline access with a consent prompt, so it gets a refresh token and Workers keep access after the first hour.

### Create a Google Cloud project and enable Drive

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (or pick one).
2. Go to **APIs & Services → Library**, search **Google Drive API**, and click **Enable**.

### Configure the consent screen

Go to **Google Auth Platform** (APIs & Services → OAuth consent screen):

1. **Branding**: set the app name and a support email.
2. **Audience**:
   - If everyone who will link an account is in one Google Workspace, choose **Internal**. No test user list, and refresh tokens don't expire after 7 days.
   - Otherwise choose **External** and leave it in **Testing**. Under **Test users**, add the Google email of every person who will link an account (up to 100). Anyone not on the list gets "access blocked".
3. **Data access**: click **Add or remove scopes** and add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, and `.../auth/drive.readonly`. Save.

`drive.readonly` is a restricted scope. Publishing an External app to Production needs Google's verification and a security assessment, so this project stays in Testing for now. In Testing, **refresh tokens expire after 7 days**, so people need to run `/connect` again about once a week. When a token stops working, the Worker sets the ticket to blocked and the bot asks the person to reconnect.

### Create the OAuth client

1. Go to **Clients → Create client** (APIs & Services → Credentials → Create credentials → OAuth client ID).
2. **Application type**: **Web application**.
3. **Authorized redirect URIs**: add `<PUBLIC_URL>/api/auth/callback/google` for account linking, and `<PUBLIC_URL>/api/auth/callback/google-signin` for signing in to the dashboard with Google. Locally that is:
   ```text
   http://localhost:8080/api/auth/callback/google
   http://localhost:8080/api/auth/callback/google-signin
   ```
   No JavaScript origins are needed.
4. Click **Create** and copy the values into `.env`:
   ```sh
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

The same client also signs people in to the dashboard: see [Dashboard sign-in](../guide/setup.md#dashboard-sign-in).

Then [turn on account linking](../guide/setup.md#turn-on-account-linking).
