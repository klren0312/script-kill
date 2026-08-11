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

/** 生成后用于审稿/润色的 story 系列 skill（按主题复用网文写作方法论）。 */
export const STORY_OPTIMIZE_SKILLS = [
	"story-review",
	"story-deslop",
	"story-short-write",
	"story-long-write",
] as const;

export function loadJubenshaSkill(): string {
	const file = resolve(skillsDir, "jubensha-gen", "SKILL.md");
	return readFileSync(file, "utf8");
}

/** 加载用于剧本优化的 story 系列 skill 文本。 */
export function loadStoryOptimizeSkills(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of STORY_OPTIMIZE_SKILLS) {
		out[name] = readFileSync(resolve(skillsDir, name, "SKILL.md"), "utf8");
	}
	return out;
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

/** 剧本中不可被优化改动的「游戏事实」指纹：任何一处变化即判定优化越界，回退原稿。 */
function gameFactsFingerprint(script: Script): string {
	return JSON.stringify({
		id: script.id,
		playerCount: script.playerCount,
		truth: script.truth,
		roleIds: script.roles.map((r) => r.id),
		locationIds: script.locations.map((l) => l.id),
		publicClueIds: script.publicClues.map((c) => c.id),
	});
}

const OPTIMIZE_FRAME =
	`你是剧本杀剧本的审稿与润色专家。下面给你 4 份「网文写作工具集」skill 文档（story-review 审稿、story-deslop 去AI味、story-short-write 短篇写作、story-long-write 长篇写作），作为你的方法论参考。\n\n` +
	`注意：这些 skill 文档原本用于命令行交互式写作工具链，其中关于 agent 部署、slash command、参考文件路径、.story-deployed 哨兵、扫榜/封面等指令对本任务无效，请忽略；只采纳其中的写作方法论与审稿维度（结构、人物、文字、设定一致性、情绪与节奏、去AI味的具体手法）。\n\n` +
	`你的任务：审查并优化一个剧本杀剧本的 JSON，输出优化后的完整剧本 JSON。\n\n` +
	`【硬性约束，违反即失败】\n` +
	`1. 只输出优化后的完整剧本 JSON 本体：不要用 markdown 代码块包裹，不要输出任何解释、前言或后记。\n` +
	`2. 故事事实一律不变：真凶、动机、手法、时间线、每个角色的身份与秘密、每条线索的含义、公共线索、地点、胜利条件、角色数量与 id。你只允许改进「表达层」：叙述文字、场景与细节描写、对话质量、人物口吻、节奏、去除AI腔（模板化、书面腔、过度工整、过度解释）。\n` +
	`3. 线索文本不得直接点名真凶。\n` +
	`4. 输出必须能通过剧本 JSON Schema 校验，且不得遗漏或改写任何字段。\n`;

/** 生成后用 story 系列 skill 审稿+去AI味+叙事打磨，输出仍须通过 schema 与「游戏事实未变」双校验，否则回退原稿。 */
async function optimizeScript(
	script: Script,
	factory: AgentFactory,
	genModel: ResolvedModel,
): Promise<Script> {
	const skills = loadStoryOptimizeSkills();
	const skillBlock = STORY_OPTIMIZE_SKILLS.map(
		(name) => `===== ${name} =====\n${skills[name]}`,
	).join("\n\n");
	const agent = factory.create({
		systemPrompt: `${OPTIMIZE_FRAME}\n\n${skillBlock}`,
		model: genModel.model,
		thinkingLevel: genModel.thinkingLevel,
	});
	const before = gameFactsFingerprint(script);
	await agent.prompt(
		`请审查并优化以下剧本，输出优化后的完整 JSON：\n${JSON.stringify(script, null, 2)}`,
	);
	const text = lastAssistantText(agent);
	const parsed = extractJson(text);
	if (parsed === undefined) {
		console.warn("[generate] 优化步骤未产出 JSON，已回退到原稿");
		return script;
	}
	const result = validateScript(parsed);
	if (!result.ok) {
		console.warn(`[generate] 优化结果未通过校验（${result.errors.slice(0, 3).join("; ")}），已回退到原稿`);
		return script;
	}
	if (gameFactsFingerprint(result.script) !== before) {
		console.warn("[generate] 优化结果改动游戏事实，已回退到原稿");
		return script;
	}
	return result.script;
}

export async function generateScript(
	req: GenerationRequest,
	factory: AgentFactory,
	genModel: ResolvedModel,
	opts: { optimize?: boolean } = {},
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
			if (opts.optimize) {
				return await optimizeScript(script, factory, genModel);
			}
			return script;
		}
		lastErrors = result.errors.slice(0, 10).join("; ");
	}
	throw new Error(`生成剧本 ${MAX_ATTEMPTS} 次均未通过校验。最近错误: ${lastErrors}`);
}
