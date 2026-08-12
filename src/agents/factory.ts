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

const BLOCK_TEXT = "text";

/** 所有主流 provider 的工具调用内容块 type 别名。pi-ai 会把各厂商格式归一为这些。 */
const TOOL_CALL_TYPES = new Set([
	"tool_call",
	"toolCall", // @anthropic / OpenAI-compat
	"tool_use", // Claude / Anthropic 原始
	"function_call", // OpenAI 旧版
	"function",
	"custom_tool_call",
	"tool_search_call",
]);

/** 工具执行后 agent-core 写入的工具结果消息 role 别名。 */
const TOOL_RESULT_ROLES = new Set(["toolResult", "tool"]);

function isToolCallBlock(block: { type?: string }): boolean {
	return typeof block.type === "string" && TOOL_CALL_TYPES.has(block.type);
}

/** 取最近一条 assistant 消息的纯文本（仅 text 块，排除 thinking / 工具参数）。 */
export function lastAssistantText(agent: Agent): string {
	const msgs = agent.state.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant") continue;
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts = content
				.filter((b) => (b as { type?: string }).type === BLOCK_TEXT)
				.map((b) => (b as { text?: string }).text ?? "");
			if (parts.some((p) => p.trim())) return parts.join("");
		}
	}
	return "";
}

/**
 * 判断 agent 最近一次回合是否调用过工具（工具消息曾进入 state.messages）。
 *
 * `prompt()` 返回后 agent-core 的内部 `pendingToolCalls` 已被清空，故改用两条
 * 结构性信号回扫最近一段回合，任一命中即视为本轮用过工具：
 *   1. 出现 `role: toolResult` / `tool` 的消息 —— 工具已执行并被 agent-core 落库；
 *   2. assistant 消息内容里含工具调用块 —— type 覆盖 tool_call/toolCall/tool_use/
 *      function_call/function 等 provider 别名。
 * 遇到 `role: user` 消息则越过了本回合边界、视为没用。
 *
 * 这两条信号都直接来自 agent-core / pi-ai 的归一化结构，不依赖 `thinkingLevel`
 * 或某个特定 type 字符串，换 provider 或升级核心库也稳健。
 *
 * 用途：agent 用工具（如 speak）后，模型的「工具参数」才是唯一入记录的台词；
 * 模型 tool 调用后附带的旁白/策略备注（心声）不应作为发言落入公开记录，
 * 故调用方据此抑制 `runAiTurn` 的兜底 `performSpeak`。
 */
export function agentCalledTool(agent: Agent): boolean {
	const msgs = agent.state.messages;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i] as { role?: string; content?: unknown };
		if (m.role === "user") return false;
		if (TOOL_RESULT_ROLES.has(m.role ?? "")) return true;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			if (m.content.some(isToolCallBlock)) return true;
		}
	}
	return false;
}
