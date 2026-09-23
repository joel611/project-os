import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { app } from "../index";
import { makeTestD1 } from "./test-d1";

interface Env {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
}

describe("apps/api", () => {
  let d1: Awaited<ReturnType<typeof makeTestD1>>;
  let env: Env;

  beforeAll(async () => {
    d1 = await makeTestD1();
    env = {
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-00",
      BETTER_AUTH_URL: "http://localhost:8787",
      DB: d1.binding,
    };
  });

  afterAll(() => d1.dispose());

  it("creates and lists tasks", async () => {
    const created = await app.request(
      "/api/tasks",
      {
        body: JSON.stringify({ title: "api test" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      env
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { title: string };
    expect(createdBody.title).toBe("api test");

    const listed = await app.request("/api/tasks", {}, env);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as unknown[];
    expect(listedBody.length).toBeGreaterThan(0);
  });

  it("updates and deletes a task", async () => {
    const created = await app.request(
      "/api/tasks",
      {
        body: JSON.stringify({ title: "to update" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      env
    );
    const { id } = (await created.json()) as { id: number };

    const updated = await app.request(
      `/api/tasks/${id}`,
      {
        body: JSON.stringify({ done: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      env
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { done: boolean };
    expect(updatedBody.done).toBe(true);

    const removed = await app.request(
      `/api/tasks/${id}`,
      { method: "DELETE" },
      env
    );
    expect(removed.status).toBe(200);
  });

  it("404s when updating a task that does not exist", async () => {
    const res = await app.request(
      "/api/tasks/999999",
      {
        body: JSON.stringify({ done: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it("rejects task creation without a title", async () => {
    const res = await app.request(
      "/api/tasks",
      {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it("signs up and reads the session through the Better Auth mount", async () => {
    const email = `api-${crypto.randomUUID()}@example.com`;
    const signUpRes = await app.request(
      "/api/auth/sign-up/email",
      {
        body: JSON.stringify({
          email,
          name: "Api User",
          password: "correct-horse-battery",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      env
    );
    expect(signUpRes.status).toBe(200);
    const cookie = signUpRes.headers.getSetCookie().join("; ");

    const sessionRes = await app.request(
      "/api/auth/get-session",
      { headers: { cookie } },
      env
    );
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { user: { email: string } };
    expect(session.user.email).toBe(email);
  });
});
