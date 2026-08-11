import type { Script } from "../domain/schema.js";

export function buildNarratorPrompt(script: Script): string {
	const culprit = script.roles.find((r) => r.id === script.truth.culprit);
	const rolePublic = script.roles
		.map((r) => `- ${r.id}（${r.name}）：${r.public}`)
		.join("\n");
	const locations = script.locations
		.map(
			(l) =>
				`- ${l.id}（${l.name}）：${l.description}；线索：${
					l.clues.map((c) => `[${c.id}] ${c.text}`).join(" / ") || "（无）"
				}`,
		)
		.join("\n");
	return `你是剧本杀《${script.title}》的主持人（DM），负责推进剧情、裁定调查、主持投票、揭晓真相。

【背景】${script.setting.background}
【时间】${script.setting.time}　【地点】${script.setting.place}
【公共线索】
${script.publicClues.map((c) => `[${c.id}] ${c.text}`).join("\n") || "（无）"}

【完整真相】（仅你知晓，揭晓前不得泄露）
真凶是「${culprit?.name ?? script.truth.culprit}」（角色 id: ${script.truth.culprit}）。
动机：${script.truth.motive}
手法：${script.truth.method}
时间线：
${script.truth.timeline.map((t) => `${t.time} ${t.event}`).join("\n")}

【地点与线索】
${locations}

【所有角色公开信息】
${rolePublic}

【主持人规则】
1. 在投票揭晓之前，你绝不能直接说出真凶身份、作案手法，或任何未公开的关键事实。
2. 调查地点的结果必须严格依据剧本设定线索，可加以场景化描写，但不得编造额外关键证据。
3. 调查某个角色的结果，可以结合真相给出符合剧情的发现（言行、物证、疑点），但绝不能泄露真凶身份。
4. 叙述要简洁、有戏剧感，使用主持人口吻。
5. 揭晓阶段（phase 为 reveal）时，你需要完整、清楚地揭晓真相。`;
}

export interface LeakInfo {
	culpritNames: string[];
	methodTokens: string[];
}

export function buildLeakInfo(script: Script): LeakInfo {
	const culprit = script.roles.find((r) => r.id === script.truth.culprit);
	const culpritNames = [script.truth.culprit];
	if (culprit) culpritNames.push(culprit.name);
	const methodTokens = script.truth.method
		.split(/[，。；、,.;:：\s]+/)
		.filter((t) => t.length >= 2);
	return { culpritNames, methodTokens };
}

/** 返回命中的泄露词；未命中返回 null。 */
export function leakCheck(text: string, info: LeakInfo): string | null {
	const hit = info.culpritNames.find((n) => n && text.includes(n));
	if (hit) return hit;
	return info.methodTokens.find((t) => t && text.includes(t)) ?? null;
}

export function maskLeaks(text: string, info: LeakInfo): string {
	let out = text;
	// 真凶名与手法词都可能泄露真相，均做确定性脱敏兜底（模型二次改写仍可能遗漏）。
	for (const n of info.culpritNames) out = out.split(n).join("某位玩家");
	for (const t of info.methodTokens) out = out.split(t).join("某些手段");
	return out;
}
