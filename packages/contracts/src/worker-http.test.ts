import { describe, expect, it } from "vite-plus/test";
import { decodeWorkerTaskType, workerTicketUrl } from "./worker-http.ts";

describe("workerTicketUrl", () => {
  it("puts each per-ticket route next to the MCP endpoint", () => {
    expect(workerTicketUrl("http://c:8080/mcp", "skills", "t1")).toBe(
      "http://c:8080/tickets/t1/skills",
    );
    expect(workerTicketUrl("http://c:8080/mcp/", "taskType", "t1")).toBe(
      "http://c:8080/tickets/t1/task-type",
    );
    expect(workerTicketUrl("https://c/base/mcp", "runs", "t 1/$&")).toBe(
      "https://c/base/tickets/t%201%2F%24%26/runs",
    );
  });
});

describe("decodeWorkerTaskType", () => {
  it("keeps the name and instructions, and drops what a Worker doesn't read", () => {
    expect(decodeWorkerTaskType({ id: "s1", name: "dev", instructions: "" })).toStrictEqual({
      name: "dev",
      instructions: "",
    });
  });

  it("rejects anything else", () => {
    for (const body of [null, "dev", [], {}, { name: "dev" }, { name: 1, instructions: "x" }]) {
      expect(decodeWorkerTaskType(body)).toBeUndefined();
    }
  });
});
