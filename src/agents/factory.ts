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

/**
 * 判断 agent 最近一次回合是否调用过工具。
 *
 * `state.messages` 是完整对话历史。`prompt()` 返回后 `pendingToolCalls` 已被清空，
 * 故回扫最近一段回合：从末尾向前的 assistant 消息里只要出现 `type:"tool_call"`
 * 块即视为本轮用过工具；遇到 user 消息则越过了本回合边界、视为没用。
 *
 * 用途：agent 用工具（如 speak）后，模型常会在 post-tool 的 assistant 文本里
 * 写出策略备注 / 内心独白；该文本不应作为发言落入公开记录，故调用方据此抑制
 * `runAiTurn` 的兜底 `performSpeak`。
 */
export function agentCalledTool(agent: Agent): boolean {
	const msgs = agent.state.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as { role?: string; content?: unknown };
		if (m.role === "user") return false;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			if (m.content.some((b) => (b as { type?: string }).type === "tool_call")) return true;
		}
	}
	return false;
}
