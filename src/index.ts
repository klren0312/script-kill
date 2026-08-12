import { buildServer } from "./server/index.js";
import {
	buildModelsRegistry,
	loadModelsConfigFile,
	resolveRoleModel,
	validateConfig,
} from "./config/models.js";
import type { GameDeps } from "./server/games.js";

const config = loadModelsConfigFile();
const models = buildModelsRegistry(config);

// 启动预检：模型角色是否都能解析，缺失则给出明确告警（修复 #12）。
const problems = validateConfig(config, models);
if (problems.length > 0) {
	console.warn("[配置预检] 以下问题可能影响运行：");
	for (const p of problems) console.warn(`  - ${p}`);
}

const generator = resolveRoleModel(config, models, "generator");
const narrator = resolveRoleModel(config, models, "narrator");
const player = resolveRoleModel(config, models, "player");

const deps: GameDeps = {
	models,
	generatorModel: generator.model,
	generatorThinking: generator.thinkingLevel ?? "high",
	narratorModel: narrator.model,
	narratorThinking: narrator.thinkingLevel ?? "medium",
	playerModel: player.model,
	playerThinking: player.thinkingLevel ?? "low",
};

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || "0.0.0.0";

const app = await buildServer(deps);

try {
	await app.listen({ port, host });
	console.log(`剧本杀系统已启动: http://${host}:${port}`);
} catch (e) {
	app.log.error(e);
	process.exit(1);
}
