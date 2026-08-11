import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { Model, MutableModels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { configPath } from "../paths.js";
import { ensureEnvLoaded } from "./env.js";

export type RoleKey = "generator" | "narrator" | "player";

export interface ProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models?: { id: string; name?: string }[];
}

export interface RoleConfig {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ModelsConfigFile {
	providers: Record<string, ProviderConfig>;
	roles: Record<RoleKey, RoleConfig>;
}

export interface ResolvedModel {
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

export function loadModelsConfigFile(): ModelsConfigFile {
	ensureEnvLoaded(); // 先加载 .env，使 $ENV_VAR 可解析
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<ModelsConfigFile>;
	if (!raw.providers || !raw.roles) {
		throw new Error("config/models.json 需要 providers 和 roles 字段");
	}
	for (const key of ["generator", "narrator", "player"] as const) {
		if (!raw.roles[key]) throw new Error(`config/models.json 缺少 roles.${key}`);
	}
	return raw as ModelsConfigFile;
}

/** 支持字面量、$ENV_VAR、!command 三种取值方式（与 pi 的 models.json 语义一致）。 */
function interpolateKey(spec?: string): string | undefined {
	if (!spec) return undefined;
	if (spec.startsWith("$") && !spec.startsWith("${")) {
		return process.env[spec.slice(1)];
	}
	if (spec.startsWith("!")) {
		return execSync(spec.slice(1), { encoding: "utf8" }).trim();
	}
	return spec;
}

export function buildModelsRegistry(config: ModelsConfigFile): MutableModels {
	const models = builtinModels();
	for (const [id, pc] of Object.entries(config.providers)) {
		const baseUrl = pc.baseUrl;
		if (!baseUrl) continue; // 内置 provider（builtinModels 已注册）
		const apiName = pc.api ?? "openai-completions";
		let api;
		if (apiName === "openai-completions") {
			api = openAICompletionsApi();
		} else if (apiName === "anthropic-messages") {
			api = anthropicMessagesApi();
		} else {
			throw new Error(
				`provider "${id}": 自定义 provider 仅支持 api "openai-completions" 或 "anthropic-messages"，当前为 "${apiName}"`,
			);
		}
		const provider = createProvider({
			id,
			name: id,
			baseUrl,
			api,
			auth: {
				apiKey: {
					name: `${id} API key`,
					resolve: async () => {
						const key = interpolateKey(pc.apiKey);
						return key ? { auth: { apiKey: key }, source: "config" } : undefined;
					},
				},
			},
			models: (pc.models ?? []).map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				api: apiName as "openai-completions" | "anthropic-messages",
				provider: id,
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			})),
		});
		models.setProvider(provider);
	}
	return models;
}

export function resolveRoleModel(
	config: ModelsConfigFile,
	models: MutableModels,
	key: RoleKey,
): ResolvedModel {
	const rc = config.roles[key];
	const model = models.getModel(rc.provider, rc.model);
	if (!model) {
		throw new Error(
			`模型未找到: roles.${key} = ${rc.provider}/${rc.model}（可编辑 config/models.json 修改，或添加自定义 provider）`,
		);
	}
	return { model, thinkingLevel: rc.thinkingLevel };
}

export function validateConfig(config: ModelsConfigFile, models: MutableModels): string[] {
	const problems: string[] = [];
	for (const key of ["generator", "narrator", "player"] as const) {
		const rc = config.roles[key];
		if (!models.getModel(rc.provider, rc.model)) {
			problems.push(`roles.${key}: ${rc.provider}/${rc.model} 不可用`);
		}
	}
	return problems;
}
