import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scriptsDir } from "../paths.js";
import { validateScript, type Script } from "./schema.js";

function fileFor(id: string): string {
	return join(scriptsDir, `${id}.json`);
}

export function saveScript(script: Script): void {
	mkdirSync(scriptsDir, { recursive: true });
	const result = validateScript(script);
	if (!result.ok) {
		throw new Error(`剧本无效: ${result.errors.join("; ")}`);
	}
	writeFileSync(fileFor(script.id), JSON.stringify(script, null, 2), "utf8");
}

export function getScript(id: string): Script | undefined {
	const file = fileFor(id);
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		const result = validateScript(parsed);
		if (!result.ok) return undefined;
		return result.script;
	} catch {
		return undefined;
	}
}

export function listScripts(): Script[] {
	mkdirSync(scriptsDir, { recursive: true });
	const out: Script[] = [];
	for (const f of readdirSync(scriptsDir)) {
		if (!f.endsWith(".json")) continue;
		const script = getScript(f.slice(0, -5));
		if (script) out.push(script);
	}
	return out;
}

export interface ScriptCard {
	id: string;
	title: string;
	genre: string;
	description: string;
	playerCount: number;
	estimatedMinutes: number;
	difficulty: string;
}

export function scriptCard(script: Script): ScriptCard {
	return {
		id: script.id,
		title: script.title,
		genre: script.genre,
		description: script.description,
		playerCount: script.playerCount,
		estimatedMinutes: script.estimatedMinutes,
		difficulty: script.difficulty,
	};
}

export function resolveClueText(script: Script, clueId: string): string | undefined {
	const pc = script.publicClues.find((c) => c.id === clueId);
	if (pc) return pc.text;
	for (const loc of script.locations) {
		const c = loc.clues.find((x) => x.id === clueId);
		if (c) return c.text;
	}
	return undefined;
}

/** 供选角页面使用的安全视图：不含任何 secret、线索、真相。 */
export interface RoleSelectInfo {
	id: string;
	name: string;
	public: string;
	goal: string;
}

export interface ScriptSelectView {
	id: string;
	title: string;
	genre: string;
	description: string;
	difficulty: string;
	playerCount: number;
	estimatedMinutes: number;
	setting: { time: string; place: string; background: string };
	roles: RoleSelectInfo[];
	locations: { id: string; name: string; description: string }[];
	publicClues: { id: string; text: string }[];
}

export function scriptSelectView(script: Script): ScriptSelectView {
	return {
		id: script.id,
		title: script.title,
		genre: script.genre,
		description: script.description,
		difficulty: script.difficulty,
		playerCount: script.playerCount,
		estimatedMinutes: script.estimatedMinutes,
		setting: { ...script.setting },
		roles: script.roles.map((r) => ({ id: r.id, name: r.name, public: r.public, goal: r.goal })),
		locations: script.locations.map((l) => ({ id: l.id, name: l.name, description: l.description })),
		publicClues: script.publicClues.map((c) => ({ id: c.id, text: c.text })),
	};
}

/** 玩家选定角色后，服务端返回该角色的完整信息与可出示线索文本。 */
export function humanRoleView(script: Script, roleId: string) {
	const role = script.roles.find((r) => r.id === roleId);
	if (!role) return undefined;
	const clueTexts = role.clues
		.map((id) => ({ id, text: resolveClueText(script, id) }))
		.filter((c): c is { id: string; text: string } => c.text !== undefined);
	return {
		role: {
			id: role.id,
			name: role.name,
			public: role.public,
			secret: role.secret,
			goal: role.goal,
			relationships: role.relationships,
		},
		clueTexts,
		publicClues: script.publicClues.map((c) => ({ id: c.id, text: c.text })),
	};
}
