import { createAgentFactory } from "../src/agents/factory.js";
import { generateScript } from "../src/agents/generation.js";
import { buildModelsRegistry, loadModelsConfigFile, resolveRoleModel } from "../src/config/models.js";
import { saveScript } from "../src/domain/script-library.js";

const [topic, playerCountStr, genre, difficulty, id] = process.argv.slice(2);
if (!topic) {
	console.error('用法: npm run generate -- "题材/背景" [玩家人数] [类型] [难度] [剧本id]');
	process.exit(1);
}

const config = loadModelsConfigFile();
const models = buildModelsRegistry(config);
const gen = resolveRoleModel(config, models, "generator");
const factory = createAgentFactory(models);

const script = await generateScript(
	{
		topic,
		playerCount: Number(playerCountStr) || 5,
		genre,
		difficulty,
		id,
	},
	factory,
	gen,
	{ optimize: true }, // 生成后用 .agents/skills 里 story 系列 skill 审稿/去AI味/打磨
);

saveScript(script);
console.log(`已生成剧本 ${script.id}：《${script.title}》（${script.roles.length} 人 · ${script.genre}）`);
