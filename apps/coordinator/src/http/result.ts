import { Effect } from "effect";

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

/** Every typed failure the HTTP handlers can surface, with its status code. */
const STATUS = {
  SchemaError: 400,
  TicketNotFound: 404,
  ProjectNotFound: 404,
  SourceNotFound: 404,
  SourceAlreadyLinked: 409,
  SourceAliasTaken: 409,
  InvalidSourceAlias: 400,
  InvalidTransition: 409,
  AgentRuntimeError: 502,
  ClassifierError: 502,
} as const;

type KnownError = { readonly _tag: keyof typeof STATUS };

/** Success becomes `{ status, body }`; known failures become `{ status, body: { error, ... } }`. */
export const toResult = <A, E extends KnownError, R>(
  effect: Effect.Effect<A, E, R>,
  status = 200,
): Effect.Effect<HttpResult, never, R> =>
  effect.pipe(
    Effect.map((body): HttpResult => ({ status, body })),
    Effect.catch((e) =>
      Effect.succeed<HttpResult>({
        status: STATUS[e._tag],
        body: { error: e._tag, detail: String(e) },
      }),
    ),
  );
