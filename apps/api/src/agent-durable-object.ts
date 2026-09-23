import { DurableObject } from "cloudflare:workers";

/**
 * Binding surface only — LLM orchestration, tool calling, and citation
 * assembly are separate work (see issue #2's Out of Scope).
 */
export class AgentDurableObject extends DurableObject {}
