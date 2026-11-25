#!/usr/bin/env bun
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createPiAcpAgent } from "./agent.ts";
import { piSessionFactory } from "./pi.ts";

// stdout carries the protocol, so everything else goes to stderr.
const skillPaths = (process.env.PI_ACP_SKILL_PATHS ?? "").split(":").filter(Boolean);
const app = createPiAcpAgent({
  createSession: piSessionFactory({
    ...(process.env.PI_ACP_MODEL && { model: process.env.PI_ACP_MODEL }),
    skillPaths,
  }),
  log: (message) => console.error(`pi-acp: ${message}`),
});
const connection = app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
