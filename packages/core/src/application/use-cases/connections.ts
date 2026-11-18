import type { ChannelType, ConnectionProvider, TicketEvent } from "@project-os/contracts";
import { Effect } from "effect";
import {
  ChannelGateway,
  KeyValueStore,
  NotConnected,
  type Person,
  type SharedAccountRef,
  TicketRepository,
  UserConnections,
} from "../ports/index.ts";
import { audit, COORDINATOR } from "./audit.ts";
import { ticketChannel } from "./prompts.ts";

export const PROVIDER_LABELS: Record<ConnectionProvider, string> = {
  google: "Google",
  github: "GitHub",
  clickup: "ClickUp",
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** The person behind a `created` or `follow_up` event, from the sender inbound stored on it. */
export const senderOf = (event: TicketEvent): Person | undefined => {
  if (event.type !== "created" && event.type !== "follow_up") return undefined;
  const payload = asRecord(event.payload);
  const sender = asRecord(payload.sender);
  if (typeof sender.id !== "string") return undefined;
  const channelType = (
    typeof payload.channelType === "string" ? payload.channelType : "discord"
  ) as ChannelType;
  return {
    channelType,
    id: sender.id,
    ...(typeof sender.name === "string" ? { name: sender.name } : {}),
  };
};

/** The person whose account a Worker acts with: the author of the ticket's latest message. */
export const requesterOf = (events: ReadonlyArray<TicketEvent>): Person | undefined =>
  events.map(senderOf).findLast((p) => p !== undefined);

/** Discord pings by `<@id>`; elsewhere the id is the address (e.g. an email). */
const mention = (person: Person) =>
  person.channelType === "discord" ? `<@${person.id}>` : person.id;

/** Who a Worker acted as, written so anyone can trace it: `<@id> (Name)` on Discord. */
export const actingAs = (person: Person) =>
  person.name === undefined
    ? mention(person)
    : person.channelType === "discord"
      ? `${mention(person)} (${person.name})`
      : `${person.name} (${person.id})`;

const EVENT_SCAN = 500;

/** What a ticket's Worker acted with from a shared account, kept for the thread's notices. */
interface SharedUse extends SharedAccountRef {
  readonly provider: ConnectionProvider;
}

const sharedUseKey = (ticketId: string) => `shared-use:${ticketId}`;
const SHARED_USE_TTL_SECONDS = 7 * 86_400;

const describeShared = (use: SharedAccountRef & { readonly provider: ConnectionProvider }) =>
  `${PROVIDER_LABELS[use.provider]} account "${use.label}"${use.identity ? ` (${use.identity})` : ""}`;

/** The shared accounts a ticket's Worker has used, as one clause: ``, via shared GitHub …``. */
export const sharedUseClause = (ticketId: string) =>
  Effect.gen(function* () {
    const raw = yield* (yield* KeyValueStore).get(sharedUseKey(ticketId));
    if (!raw) return "";
    const uses = JSON.parse(raw) as ReadonlyArray<SharedUse>;
    return `, via shared ${uses.map(describeShared).join("; ")}`;
  });

/** Notes in the ticket's thread and audit log that a shared account was used, once each. */
const noteSharedUse = (
  ticketId: string,
  projectId: string,
  person: Person,
  provider: ConnectionProvider,
  shared: SharedAccountRef,
) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const key = sharedUseKey(ticketId);
    const known = JSON.parse((yield* kv.get(key)) ?? "[]") as ReadonlyArray<SharedUse>;
    if (known.some((u) => u.provider === provider && u.id === shared.id)) return;
    yield* kv.set(key, JSON.stringify([...known, { ...shared, provider }]), {
      ttlSeconds: SHARED_USE_TTL_SECONDS,
    });
    yield* audit({
      kind: "connection",
      action: "shared_account_used",
      actor: COORDINATOR,
      projectId,
      ticketId,
      summary: `Ticket acted for ${actingAs(person)} with shared ${describeShared({ ...shared, provider })}`,
      payload: { provider, sharedAccountId: shared.id, label: shared.label, person },
      dedupeKey: `shared-used:${ticketId}:${provider}:${shared.id}`,
    });
  }).pipe(Effect.ignore);

/** Asked in the ticket's thread when a Worker needs an account the person hasn't linked. */
export const connectAskMessage = (
  person: Person,
  label: string,
  title: string,
  provider: ConnectionProvider,
) =>
  `${mention(person)}, I need your ${label} access for "${title}". Run \`/connect provider:${provider}\`, then reply here and I'll carry on. (The Worker acted as ${actingAs(person)}, the author of this ticket's latest message.)`;

/**
 * The access token a Worker should use for `provider` on this ticket: the token of whoever
 * wrote the ticket's latest message (the requester, or the latest follow-up's author). If they
 * haven't linked the provider, asks them in the ticket's thread (once a day per ticket) and
 * fails with `NotConnected`; their reply there resumes the blocked ticket.
 */
export const userTokenForTicket = (input: {
  readonly ticketId: string;
  readonly provider: ConnectionProvider;
}) =>
  Effect.gen(function* () {
    const tickets = yield* TicketRepository;
    const connections = yield* UserConnections;

    const ticket = yield* tickets.get(input.ticketId);
    const events = yield* tickets.listEvents(ticket.id, EVENT_SCAN);
    const person = requesterOf(events);
    if (!person) {
      return yield* new NotConnected({
        provider: input.provider,
        personId: "",
        message: "This ticket has no human requester, so there is no account to act as.",
      });
    }

    const token = yield* connections
      .accessToken(person, input.provider)
      .pipe(
        Effect.tapErrorTag("NotConnected", (error) =>
          error.sharedAccount
            ? askAdminToReconnect(
                ticket.id,
                ticket.title,
                person,
                input.provider,
                error.sharedAccount,
              )
            : askToConnect(ticket.id, ticket.title, person, input.provider),
        ),
      );
    if (token.sharedAccount) {
      yield* noteSharedUse(
        ticket.id,
        ticket.projectId,
        person,
        input.provider,
        token.sharedAccount,
      );
    }
    return { ...token, person: { ...person, name: person.name ?? null } };
  });

const askToConnect = (
  ticketId: string,
  title: string,
  person: Person,
  provider: ConnectionProvider,
) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const gateway = yield* ChannelGateway;

    const fresh = yield* kv.setIfAbsent(`connect-ask:${ticketId}:${provider}:${person.id}`, "1", {
      ttlSeconds: 86_400,
    });
    if (!fresh) return;
    // The ticket's thread, where their reply resumes the blocked ticket; else the channel.
    const target = yield* ticketChannel(ticketId);
    if (!target) return;
    const label = PROVIDER_LABELS[provider];
    yield* gateway.send({
      ...target,
      content: connectAskMessage(person, label, title, provider),
    });
  });

/** The shared account someone acts with stopped working: say so, once a day per ticket. */
const askAdminToReconnect = (
  ticketId: string,
  title: string,
  person: Person,
  provider: ConnectionProvider,
  shared: SharedAccountRef,
) =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore;
    const gateway = yield* ChannelGateway;
    const fresh = yield* kv.setIfAbsent(
      `connect-ask:${ticketId}:${provider}:shared:${shared.id}`,
      "1",
      { ttlSeconds: 86_400 },
    );
    if (!fresh) return;
    const target = yield* ticketChannel(ticketId);
    if (!target) return;
    yield* gateway.send({
      ...target,
      content: `I couldn't use the shared ${describeShared({ ...shared, provider })} for "${title}": its link has expired or was revoked. An admin needs to reconnect it in the dashboard (Members → Shared accounts), then reply here and I'll carry on. (The Worker acted as ${actingAs(person)}.)`,
    });
  });
