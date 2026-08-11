import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, MutableModels } from "@earendil-works/pi-ai";

export interface AgentFactory {
	models: MutableModels;
	create(opts: {
		systemPrompt: string;
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
		tools?: AgentTool[];
		messages?: AgentMessage[];
	}): Agent;
}

export function createAgentFactory(models: MutableModels): AgentFactory {
	const streamFn = models.streamSimple.bind(models);
	return {
		models,
		create(opts) {
			return new Agent({
				initialState: {
					systemPrompt: opts.systemPrompt,
					model: opts.model,
					thinkingLevel: opts.thinkingLevel ?? "low",
					tools: opts.tools,
					messages: opts.messages,
				},
				streamFn,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
			});
		},
	};
}

/** 取最近一条 assistant 消息的纯文本。 */
export function lastAssistantText(agent: Agent): string {
	const msgs = agent.state.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts = content
				.filter((b) => (b as { type?: string }).type === "text")
				.map((b) => (b as { text?: string }).text ?? "");
			if (parts.some((p) => p.trim())) return parts.join("");
		}
	}
	return "";
}
