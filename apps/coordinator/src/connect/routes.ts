import type { LinkStart } from "@project-os/auth";
import { Elysia } from "elysia";

export interface ConnectDeps {
  /** Redeems a one-time connect link; null when unknown, used, or expired. */
  readonly startLink: (token: string) => Promise<LinkStart | null>;
}

const LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  clickup: "ClickUp",
};

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (status: number, title: string, body: string, extra = "") =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.4rem">${escape(title)}</h1><p>${escape(body)}</p>${extra}</body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );

/**
 * Account linking for people on channels: `/connect` in Discord replies with a one-time
 * `/connect/:token` link. Opening it only shows a confirm page: `GET` has no side effects, so
 * link previews and scanners can't use up the token. The button `POST`s the same URL, which
 * signs the browser in as that person and redirects to the provider; the provider returns to
 * Better Auth's callback, which lands on `/connect/done`.
 */
export const connectRoutes = ({ startLink }: ConnectDeps) =>
  new Elysia({ name: "connect-routes" })
    .get("/connect/done", ({ query }) => {
      const label = LABELS[String(query.provider)] ?? "Your";
      return query.error
        ? page(
            400,
            "That didn't work",
            `Linking your ${label} account failed (${String(query.error)}). Run /connect again in Discord to retry.`,
          )
        : page(200, `${label} account connected`, "You can close this tab and go back to Discord.");
    })
    .get("/connect/:token", ({ params }) =>
      page(
        200,
        "Connect your account",
        "Continue to sign in with your provider and link that account to your chat identity.",
        `<form method="post" action="/connect/${escape(encodeURIComponent(params.token))}"><button type="submit" style="font:inherit;padding:.5rem 1rem">Continue</button></form>`,
      ),
    )
    .post("/connect/:token", async ({ params }) => {
      const start = await startLink(params.token).catch((error: unknown) => {
        console.error("connect: starting the provider flow failed", error);
        return undefined;
      });
      if (start === undefined) {
        return page(
          502,
          "Couldn't start linking",
          "Something went wrong reaching the provider. This link is now used up. Run /connect again in Discord for a new one.",
        );
      }
      if (!start) {
        return page(
          410,
          "This link has expired",
          "Connect links work once, for 10 minutes. Run /connect again in Discord for a new one.",
        );
      }
      const headers = new Headers({ location: start.redirect, "cache-control": "no-store" });
      for (const cookie of start.setCookies) headers.append("set-cookie", cookie);
      return new Response(null, { status: 303, headers });
    });
