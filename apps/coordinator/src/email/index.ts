import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { type ClassifyClient, makeEmailClassifier } from "@project-os/agent-runtime/classifier";
import { createGmailReader, GmailError } from "@project-os/channel-email";
import { envBool, formatModelRef, type ModelRef } from "@project-os/config";
import { GMAIL_READ_SCOPE } from "@project-os/contracts";
import {
  DEFAULT_EMAIL_DIGEST,
  type EmailDigestConfig,
  EmailSource,
  EmailSourceError,
  Scheduler,
  syncMailboxes,
  UserConnections,
} from "@project-os/core";
import { Effect, Layer } from "effect";

type Env = Readonly<Record<string, string | undefined>>;

/** `EMAIL_DIGEST`: people may let the Coordinator read their Gmail into Project Memory. Off unless set. */
export const emailDigestEnabled = (env: Env): boolean => envBool("EMAIL_DIGEST", false, env);

/** The Email Digest's classifier: Jev, the same model that reads Discord requests. */
export const emailClassifier = (
  models: ClassifyClient & {
    getModelOfType(
      type: "classifier",
      provider: string,
      id: string,
    ): ClassifierModel<ClassifierApi> | undefined;
  },
  ref: ModelRef,
) => {
  const model = models.getModelOfType("classifier", ref.provider, ref.modelId);
  if (!model) throw new Error(`Unknown decision model ${formatModelRef(ref)}`);
  return makeEmailClassifier({ classifier: models, model });
};

/**
 * Mailbox reading over Gmail's API, with each person's own Google link (read-only scope). A
 * missing link, a link made before the Gmail scope was asked for, or a refused token all mean
 * the person has to `/connect google` again.
 */
export const gmailEmailSource = (options?: {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}) =>
  Layer.effect(
    EmailSource,
    Effect.gen(function* () {
      const connections = yield* UserConnections;
      const reader = createGmailReader(options);
      return {
        sync: ({ owner, cursor, limit }) =>
          Effect.gen(function* () {
            const token = yield* connections.accessToken(owner, "google").pipe(
              Effect.mapError(
                (e) =>
                  new EmailSourceError({
                    message: e.message,
                    reconnect: e._tag === "NotConnected",
                  }),
              ),
            );
            if (!token.scopes.includes(GMAIL_READ_SCOPE)) {
              return yield* new EmailSourceError({
                message: "The Google link has no Gmail read access",
                reconnect: true,
              });
            }
            return yield* Effect.tryPromise({
              try: () => reader.sync({ token: token.accessToken, cursor, limit }),
              catch: (e) =>
                new EmailSourceError({
                  message: e instanceof Error ? e.message : String(e),
                  reconnect: e instanceof GmailError && e.reconnect,
                }),
            });
          }),
      };
    }),
  );

type Sync = ReturnType<typeof syncMailboxes>;

/** One Email Digest run, logged. A failure is logged and never stops the Cron tick or timer. */
export const emailDigestAndLog = (config: EmailDigestConfig = DEFAULT_EMAIL_DIGEST) =>
  syncMailboxes(config).pipe(
    Effect.tap((run) =>
      run.emails > 0
        ? Effect.logInfo(
            `email digest: read ${run.emails} email(s) from ${run.mailboxes} mailbox(es)`,
          )
        : Effect.void,
    ),
    Effect.catchCause((cause) => Effect.logError("email digest failed", cause)),
    Effect.asVoid,
  );

/** Runs the Email Digest every `everyMs` via the `Scheduler` port (Bun). Returns the stop effect. */
export const startEmailDigest = (everyMs: number, config?: EmailDigestConfig) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler;
    const context = yield* Effect.context<Effect.Services<Sync>>();
    return yield* scheduler.every(
      "email-digest",
      everyMs,
      emailDigestAndLog(config).pipe(Effect.provideContext(context)),
    );
  });
