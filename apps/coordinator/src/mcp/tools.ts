import * as C from "@project-os/contracts";
import {
  AgentRuntime,
  appendEvent,
  ChannelGateway,
  claimTicketUseCase,
  Clock,
  getTicket,
  heartbeat,
  IdGenerator,
  KeyValueStore,
  listAssigned,
  MemoryRepository,
  ProjectSourceRepository,
  readMemory,
  TicketRepository,
  updateStatusAndNotify,
  UserConnections,
  userTokenForTicket,
  WorkerRepository,
  writeMemory,
} from "@project-os/core";
import { Effect, Schema } from "effect";

/** Services the tool use cases need; the entry file's runtime must provide them. */
export type McpServices =
  | AgentRuntime
  | ChannelGateway
  | Clock
  | IdGenerator
  | KeyValueStore
  | MemoryRepository
  | ProjectSourceRepository
  | TicketRepository
  | UserConnections
  | WorkerRepository;

export interface ToolFailure {
  readonly _tag: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

/** One MCP tool: a use case behind contract schemas. `R` is the services the use case needs. */
export interface McpTool<R> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema.Constraint;
  readonly outputSchema: Schema.Constraint;
  /** Decodes `args`, runs the use case, encodes the result. Typed failures become `ToolFailure`. */
  readonly call: (args: unknown) => Effect.Effect<unknown, ToolFailure, R>;
}

export const toFailure = (error: unknown): ToolFailure => {
  if (Schema.isSchemaError(error)) return { _tag: "InvalidInput", message: error.message };
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const { _tag, ...rest } = error as { _tag: string };
    return { ...rest, _tag, message: `${_tag}: ${JSON.stringify(rest)}` };
  }
  return { _tag: "Error", message: String(error) };
};

const define = <I extends Schema.Constraint, O extends Schema.Constraint, E, R>(spec: {
  readonly name: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly run: (input: I["Type"]) => Effect.Effect<unknown, E, R>;
}): McpTool<R> => ({
  name: spec.name,
  description: spec.description,
  inputSchema: spec.input,
  outputSchema: spec.output,
  call: (args) =>
    Schema.decodeUnknownEffect(spec.input as never)(args).pipe(
      Effect.flatMap((input) => spec.run(input as I["Type"])),
      Effect.flatMap((out) => Schema.encodeUnknownEffect(spec.output as never)(out)),
      Effect.mapError(toFailure),
    ) as Effect.Effect<unknown, ToolFailure, R>,
});

/** Worker-facing tool surface (docs/technical-architecture.md section 3.2). No channel tools. */
export const makeTools = (): readonly McpTool<McpServices>[] => [
  define({
    name: "ticket_list_assigned",
    description: "List tickets with status=assigned for this worker, oldest first.",
    input: C.TicketListAssignedInput,
    output: C.TicketListAssignedOutput,
    run: (i) => Effect.map(listAssigned(i), (tickets) => ({ tickets })),
  }),
  define({
    name: "ticket_claim",
    description:
      "Atomically claim an assigned ticket (assigned to in_progress). Fails if already claimed.",
    input: C.TicketClaimInput,
    output: C.TicketClaimOutput,
    run: (i) => Effect.map(claimTicketUseCase(i), (ticket) => ({ ticket })),
  }),
  define({
    name: "ticket_get",
    description: "Fetch a ticket with its recent events.",
    input: C.TicketGetInput,
    output: C.TicketGetOutput,
    run: getTicket,
  }),
  define({
    name: "ticket_append_event",
    description: "Append an event (status_update, comment, result, error, ...) to a ticket.",
    input: C.TicketAppendEventInput,
    output: C.TicketAppendEventOutput,
    run: (i) => Effect.map(appendEvent(i), (event) => ({ event })),
  }),
  define({
    name: "ticket_update_status",
    description: "Move a ticket to a new status (blocked, completed, failed, ...).",
    input: C.TicketUpdateStatusInput,
    output: C.TicketUpdateStatusOutput,
    run: (i) => Effect.map(updateStatusAndNotify(i), (ticket) => ({ ticket })),
  }),
  define({
    name: "project_memory_read",
    description: "Read project memory entries for a project.",
    input: C.ProjectMemoryReadInput,
    output: C.ProjectMemoryReadOutput,
    run: (i) => Effect.map(readMemory(i), (entries) => ({ entries })),
  }),
  define({
    name: "project_memory_write",
    description: "Create a project memory entry (linked to ticketId when given).",
    input: C.ProjectMemoryWriteInput,
    output: C.ProjectMemoryWriteOutput,
    run: (i) => Effect.map(writeMemory(i), (entry) => ({ entry })),
  }),
  define({
    name: "user_token",
    description:
      "Get an OAuth access token (google or github) for the person behind this ticket's latest message, " +
      "so you read Drive or GitHub with their own permissions. Use it as a Bearer token (GH_TOKEN for gh/git). " +
      "Fails with NotConnected if they haven't linked that account: the Coordinator has already asked them to " +
      "run /connect, so set the ticket to blocked and stop. Never store or print the token.",
    input: C.UserTokenInput,
    output: C.UserTokenOutput,
    run: userTokenForTicket,
  }),
  define({
    name: "worker_heartbeat",
    description: "Report that this worker is alive, optionally with its current ticket.",
    input: C.WorkerHeartbeatInput,
    output: C.WorkerHeartbeatOutput,
    run: (i) => Effect.map(heartbeat(i), (w) => ({ lastSeenAt: w.lastSeenAt })),
  }),
];
