import {
  BUILTIN_SKILLS,
  findSkill,
  parseSkillUri,
  skillEntry,
  skillUri,
} from "@project-os/builtin-skills";
import { Effect, Schema } from "effect";
import { z } from "zod";
import { define, type McpServices, type McpTool } from "./tools.ts";

/**
 * EXPERIMENTAL. Project OS's own skills (how to use tickets, project memory, accounts), served
 * over MCP per SEP-2640 (`skill://<name>/SKILL.md`, `skills/list`, `skills/get`) and as two plain
 * tools, because today's worker agents don't read MCP skill resources. Off unless
 * `EXPERIMENTAL_MCP_SKILLS` is set. The skills are bundled, identical for every worker and never
 * the operator's skill sets (those still install by zip).
 */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export const SkillsListRequest = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});
export const SkillsGetRequest = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }).passthrough(),
});

export const listSkillEntries = () => Promise.all(BUILTIN_SKILLS.map(skillEntry));

/** The text of one skill file by URI, or undefined when there is no such file. */
export const readSkillFile = (uri: string): string | undefined => {
  const parsed = parseSkillUri(uri);
  const skill = parsed && findSkill(parsed.name);
  return skill?.files[parsed?.path === "" ? "SKILL.md" : (parsed?.path ?? "")];
};

const SkillListOutput = Schema.Struct({
  skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
});
const SkillReadInput = Schema.Struct({
  name: Schema.String,
  path: Schema.optional(Schema.String),
});
const SkillReadOutput = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  content: Schema.String,
});

/** `skill_list` and `skill_read`: the same content as the resources, for agents without them. */
export const makeSkillTools = (): readonly McpTool<McpServices>[] => [
  define({
    name: "skill_list",
    description:
      "Experimental. List Project OS's built-in skills (how to use tickets, project memory and accounts) " +
      "with what each is for. Read one with skill_read before using the tool it covers.",
    input: Schema.Struct({}),
    output: SkillListOutput,
    run: () =>
      Effect.succeed({
        skills: BUILTIN_SKILLS.map(({ name, description }) => ({ name, description })),
      }),
  }),
  define({
    name: "skill_read",
    description:
      "Experimental. Read a built-in skill's SKILL.md, or one of its files by path " +
      `(skill://<name>/<path>). Names: ${BUILTIN_SKILLS.map((s) => s.name).join(", ")}.`,
    input: SkillReadInput,
    output: SkillReadOutput,
    run: (i) => {
      const path = i.path && i.path !== "" ? i.path : "SKILL.md";
      const content = readSkillFile(skillUri(i.name, path));
      return content === undefined
        ? Effect.fail({ _tag: "SkillNotFound", name: i.name, path })
        : Effect.succeed({ name: i.name, path, content });
    },
  }),
];
