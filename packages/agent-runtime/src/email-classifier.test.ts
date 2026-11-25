import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import { EmailClassifier } from "@project-os/core";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeEmailClassifier, newModels } from "./index.ts";

const models = newModels();
const model = models.getModelOfType("classifier", "openrouter", "typesafe/jev-1.14")!;

const scripted = (result: Partial<ClassifierResult>) => {
  const requests: ClassifierContext[] = [];
  return {
    requests,
    classifier: {
      classify: async (_m: unknown, context: ClassifierContext): Promise<ClassifierResult> => {
        requests.push(context);
        return {
          api: model.api,
          provider: model.provider,
          model: model.id,
          answers: {},
          stopReason: "stop",
          timestamp: 0,
          ...result,
        };
      },
    },
  };
};

const projects = [
  {
    id: "p1",
    name: "Acme",
    description: "Web shop",
    examples: [{ from: "a@b.test", subject: "Launch" }],
  },
  { id: "p2", name: "Acme", description: "", examples: [] },
  { id: "p3", name: "none", description: "", examples: [] },
];

const run = (s: ReturnType<typeof scripted>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* EmailClassifier).classify({
        from: "Dana <d@x.test>",
        subject: "Launch date",
        body: "Moving to December",
        projects,
      });
    }).pipe(Effect.provide(makeEmailClassifier({ classifier: s.classifier, model }))),
  );

const answer = (choice: string, confidence: number): Partial<ClassifierResult> => ({
  answers: {
    project: { type: "choice", choice, probabilities: { [choice]: confidence }, confidence },
  },
});

describe("makeEmailClassifier", () => {
  it("offers one option per project with its examples, plus none, and maps the choice back", async () => {
    const s = scripted(answer("Acme (2)", 0.93));
    expect(await run(s)).toEqual({ projectId: "p2", confidence: 0.93 });
    const question = s.requests[0]!.questions.project as { criteria: Record<string, string> };
    expect(Object.keys(question.criteria)).toEqual(["Acme", "Acme (2)", "none (project)", "none"]);
    expect(question.criteria.Acme).toContain("Emails filed here before:\n- from a@b.test: Launch");
    expect(s.requests[0]!.state.message).toContain("Subject: Launch date");
  });

  it("answers no project for the none option", async () => {
    expect(await run(scripted(answer("none", 0.8)))).toEqual({ projectId: null, confidence: 0.8 });
  });

  it("answers no project for a choice it never offered", async () => {
    expect(await run(scripted(answer("invented", 0.99)))).toEqual({
      projectId: null,
      confidence: 0.99,
    });
  });

  it("names the stop reason when the model errors with no message", async () => {
    await expect(run(scripted({ stopReason: "aborted" }))).rejects.toThrow("classify aborted");
  });

  it("fails when the provider throws something that is not an Error", async () => {
    const throwing = { classify: async () => Promise.reject("boom") };
    const failed = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* EmailClassifier).classify({
            from: "a",
            subject: "b",
            body: "c",
            projects,
          });
        }).pipe(Effect.provide(makeEmailClassifier({ classifier: throwing, model }))),
      ),
    );
    expect(failed.message).toBe("boom");
  });

  it("fails when the model errors or gives no project answer", async () => {
    const failed = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* (yield* EmailClassifier).classify({
            from: "a",
            subject: "b",
            body: "c",
            projects,
          });
        }).pipe(
          Effect.provide(
            makeEmailClassifier({
              classifier: scripted({ stopReason: "error", errorMessage: "rate limited" })
                .classifier,
              model,
            }),
          ),
        ),
      ),
    );
    expect(failed.message).toBe("rate limited");
    await expect(run(scripted({}))).rejects.toThrow("no `project` answer");
  });
});
