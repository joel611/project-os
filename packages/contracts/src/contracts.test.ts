import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import * as C from "./index.ts";

const ticket = {
  id: "t1",
  projectId: "p1",
  status: "assigned",
  title: "Fix bug",
  intent: "bugfix",
  inputSummary: "please fix",
  priority: null,
  workerType: "local",
  workerId: null,
  result: null,
  error: null,
  createdAt: "2026-11-04T00:00:00.000Z",
  assignedAt: "2026-11-04T00:00:01.000Z",
  startedAt: null,
  lastActivityAt: "2026-11-04T00:00:01.000Z",
  completedAt: null,
  updatedAt: "2026-11-04T00:00:01.000Z",
};

const event = {
  id: "e1",
  ticketId: "t1",
  type: "comment",
  actor: "worker",
  actorId: "w1",
  body: "hi",
  payload: { progress: 0.5 },
  createdAt: "2026-11-04T00:00:02.000Z",
};

const entry = {
  id: "m1",
  projectId: "p1",
  ticketId: "t1",
  type: "worker_note",
  title: "note",
  content: "body",
  sourceMetadata: { workerId: "w1" },
  createdBy: "w1",
  createdAt: "2026-11-04T00:00:03.000Z",
};

const cases: ReadonlyArray<readonly [string, Schema.Top, unknown]> = [
  [
    "InboundMessage",
    C.InboundMessage,
    {
      channelType: "discord",
      externalId: "m1",
      channelId: "c1",
      threadId: "th1",
      sender: { id: "u1", name: "Joel" },
      content: "hello",
      raw: { any: ["thing"] },
      receivedAt: "2026-11-04T00:00:00.000Z",
    },
  ],
  [
    "InboundMessage (minimal)",
    C.InboundMessage,
    {
      channelType: "email",
      externalId: "m2",
      channelId: "a@b.c",
      sender: { id: "a@b.c", email: "a@b.c" },
      content: "x",
      raw: null,
      receivedAt: "2026-11-04T00:00:00.000Z",
    },
  ],
  [
    "SlashCommand",
    C.SlashCommand,
    {
      channelType: "discord",
      command: "project-create",
      externalId: "i1",
      channelId: "admin",
      sender: { id: "u1", name: "Joel" },
      options: { name: "Acme", instructions: "be brief" },
    },
  ],
  ["CommandReply", C.CommandReply, { content: "ok", ephemeral: false }],
  [
    "ReplyInstruction",
    C.ReplyInstruction,
    { channelType: "discord", channelId: "c1", threadId: "th1", content: "done" },
  ],
  [
    "ReplyInstruction (no thread)",
    C.ReplyInstruction,
    { channelType: "chat", channelId: "c", content: "x" },
  ],
  ["Ticket", C.Ticket, ticket],
  ["TicketEvent", C.TicketEvent, event],
  ["MemoryEntry", C.MemoryEntry, entry],
  ["ticket_list_assigned in", C.TicketListAssignedInput, { workerId: "w1", workerType: "local" }],
  ["ticket_list_assigned out", C.TicketListAssignedOutput, { tickets: [ticket] }],
  ["ticket_claim in", C.TicketClaimInput, { ticketId: "t1", workerId: "w1" }],
  ["ticket_claim out", C.TicketClaimOutput, { ticket }],
  ["ticket_get in", C.TicketGetInput, { ticketId: "t1", eventLimit: 20 }],
  ["ticket_get out", C.TicketGetOutput, { ticket, events: [event] }],
  [
    "ticket_append_event in",
    C.TicketAppendEventInput,
    { ticketId: "t1", type: "result", actor: "worker", body: "ok", payload: { a: 1 } },
  ],
  ["ticket_append_event out", C.TicketAppendEventOutput, { event }],
  [
    "ticket_update_status in",
    C.TicketUpdateStatusInput,
    { ticketId: "t1", status: "failed", error: "boom" },
  ],
  ["ticket_update_status out", C.TicketUpdateStatusOutput, { ticket }],
  [
    "project_memory_read in",
    C.ProjectMemoryReadInput,
    { projectId: "p1", type: "note", limit: 10 },
  ],
  ["project_memory_read out", C.ProjectMemoryReadOutput, { entries: [entry] }],
  [
    "project_memory_write in",
    C.ProjectMemoryWriteInput,
    { projectId: "p1", ticketId: "t1", type: "worker_result", title: "t", content: "c" },
  ],
  ["project_memory_write out", C.ProjectMemoryWriteOutput, { entry }],
  [
    "worker_heartbeat in",
    C.WorkerHeartbeatInput,
    { workerId: "w1", workerType: "daytona_pi", ticketId: "t1" },
  ],
  ["worker_heartbeat out", C.WorkerHeartbeatOutput, { lastSeenAt: "2026-11-04T00:00:04.000Z" }],
];

describe("contracts round-trip", () => {
  it.each(cases)("%s", (_name, schema, value) => {
    const decoded = Schema.decodeUnknownSync(schema as never)(value);
    expect(decoded).toEqual(value);
    const encoded = Schema.encodeSync(schema as never)(decoded as never);
    expect(encoded).toEqual(value);
    expect(Schema.decodeUnknownSync(schema as never)(encoded)).toEqual(value);
  });

  it.each([
    ["TicketStatus", C.TicketStatus, "nope"],
    ["TicketEventType", C.TicketEventType, "nope"],
    ["Actor", C.Actor, "nope"],
    ["WorkerType", C.WorkerType, "nope"],
    ["MemoryEntryType", C.MemoryEntryType, "nope"],
    ["ChannelType", C.ChannelType, "sms"],
  ] as const)("%s rejects unknown value", (_n, schema, bad) => {
    expect(() => Schema.decodeUnknownSync(schema)(bad)).toThrow();
  });

  it("TicketStatus accepts every member", () => {
    for (const s of C.TICKET_STATUSES) {
      expect(Schema.decodeSync(C.TicketStatus)(s)).toBe(s);
    }
  });
});
