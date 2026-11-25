import { Effect } from "effect";

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

const STATUS = {
  SchemaError: 400,
  TicketNotFound: 404,
  ProjectNotFound: 404,
  WorkerNotFound: 404,
  SourceNotFound: 404,
  SourceAlreadyLinked: 409,
  SourceAliasTaken: 409,
  InvalidSourceAlias: 400,
  InvalidSourceLink: 400,
  TaskTypeNotFound: 404,
  SkillNotFound: 404,
  TaskTypeNameTaken: 409,
  InvalidTaskType: 400,
  InvalidSkillSource: 400,
  SkillFetchFailed: 502,
  InvalidTransition: 409,
  RunNotFound: 404,
  EmailNotFound: 404,
  EmailDigestFailed: 502,
  RunOutOfOrder: 409,
  RunRejected: 400,
  AssetStoreFailed: 503,
  WorkerUnauthorized: 403,
  RegistrationInvalid: 401,
  AgentRuntimeError: 502,
  ClassifierError: 502,
} as const;

type KnownError = { readonly _tag: keyof typeof STATUS };

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
