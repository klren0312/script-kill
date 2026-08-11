import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { skillsDir } from "../paths.js";
import { validateScript, type Script } from "../domain/schema.js";
import { createAgentFactory, lastAssistantText, type AgentFactory } from "./factory.js";
import type { ResolvedModel } from "../config/models.js";

export interface GenerationRequest {
	topic: string;
	playerCount: number;
	genre?: string;
	difficulty?: string;
	id?: string;
}

const MAX_ATTEMPTS = 3;

export function loadJubenshaSkill(): string {
	const file = resolve(skillsDir, "jubensha-gen", "SKILL.md");
	return readFileSync(file, "utf8");
}

function extractJson(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return undefined;
	try {
		return JSON.parse(trimmed.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

export async function generateScript(
	req: GenerationRequest,
	factory: AgentFactory,
	genModel: ResolvedModel,
): Promise<Script> {
	const skill = loadJubenshaSkill();
	const agent = factory.create({
		systemPrompt: `${skill}\n\n你是剧本杀创作引擎。你必须严格按上述 schema 输出一个完整剧本。你的回复只能是 JSON 本体：不要用 markdown 代码块包裹，不要输出任何解释或前后缀文字。`,
		model: genModel.model,
		thinkingLevel: genModel.thinkingLevel,
	});
	const basePrompt =
		`请生成一个剧本杀剧本：\n` +
		`- 主题/背景：${req.topic}\n` +
		`- 玩家人数：${req.playerCount}\n` +
		`- 类型：${req.genre ?? "本格推理"}\n` +
		`- 难度：${req.difficulty ?? "进阶"}`;

	let lastErrors = "";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const user =
			attempt === 1
				? `${basePrompt}\n\n输出完整 JSON 剧本。`
				: `${basePrompt}\n\n你上次的输出未通过校验：${lastErrors}\n请重新输出完整、合法的 JSON 剧本。确保每个字段都存在且类型正确；凶手身份、作案手法、时间线、每一条线索互相自洽；线索不得直接点名真凶。`;
		await agent.prompt(user);
		const text = lastAssistantText(agent);
		const parsed = extractJson(text);
		const result =
			parsed === undefined
				? { ok: false as const, errors: ["输出不是合法 JSON"] }
				: validateScript(parsed);
		if (result.ok) {
			const script = result.script;
			if (req.id) script.id = req.id;
			return script;
		}
		lastErrors = result.errors.slice(0, 10).join("; ");
	}
	throw new Error(`生成剧本 ${MAX_ATTEMPTS} 次均未通过校验。最近错误: ${lastErrors}`);
}
