import type { ClassifierApi, ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import { EmailClassifier, EmailClassifierError } from "@project-os/core";
import {
  EMAIL_NONE_CRITERIA,
  EMAIL_PROJECT_QUESTION,
  emailClassifyMessage,
  emailProjectCriteria,
  NO_EMAIL_PROJECT,
} from "@project-os/system-prompts";
import { Effect, Layer } from "effect";
import type { ClassifyClient } from "./intent-classifier.ts";

/** Names each project's option: its own name, numbered when two projects share one. */
const optionNames = (projects: ReadonlyArray<{ readonly id: string; readonly name: string }>) => {
  const seen = new Map<string, number>();
  return projects.map((p) => {
    const base = p.name === NO_EMAIL_PROJECT ? `${p.name} (project)` : p.name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: p.id, option: n === 1 ? base : `${base} (${n})` };
  });
};

/**
 * Jev behind the `EmailClassifier` port: one choice question with an option per project, each
 * described by the project's instructions and the emails people filed under it by hand. The
 * caller applies the confidence threshold.
 */
export const makeEmailClassifier = (input: {
  readonly classifier: ClassifyClient;
  readonly model: ClassifierModel<ClassifierApi>;
}) =>
  Layer.succeed(EmailClassifier, {
    classify: ({ from, subject, body, projects }) =>
      Effect.tryPromise({
        try: async () => {
          const named = optionNames(projects);
          const context: ClassifierContext = {
            state: { message: emailClassifyMessage({ from, subject, body }) },
            questions: {
              project: {
                type: "choice",
                instructions: EMAIL_PROJECT_QUESTION,
                criteria: {
                  ...Object.fromEntries(
                    projects.map((p, i) => [named[i]!.option, emailProjectCriteria(p)]),
                  ),
                  [NO_EMAIL_PROJECT]: EMAIL_NONE_CRITERIA,
                },
              },
            },
          };
          const result = await input.classifier.classify(input.model, context);
          if (result.stopReason !== "stop") {
            throw new Error(result.errorMessage ?? `classify ${result.stopReason}`);
          }
          const answer = result.answers.project;
          if (answer?.type !== "choice") throw new Error("classifier returned no `project` answer");
          const hit = named.find((n) => n.option === answer.choice);
          return { projectId: hit?.id ?? null, confidence: answer.confidence };
        },
        catch: (e) =>
          new EmailClassifierError({ message: e instanceof Error ? e.message : String(e) }),
      }),
  });
