import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appRoot } from "../paths.js";

let loaded = false;

/**
 * 加载项目根 `.env` 文件到 process.env（**不覆盖**已存在的环境变量，幂等）。
 *
 * config/models.json 里的 `$ENV_VAR` 通过 process.env 取值，因此任何入口
 * （HTTP 服务 / CLI 生成脚本）在解析模型配置前都应确保本函数被调用过一次。
 *
 * 支持格式：`KEY=VALUE`、可选 `export ` 前缀、`#` 注释行、空行、单/双引号值。
 * 优先级：OS 环境变量 > `.env`（即 setx/系统已设的值优先）。
 */
export function ensureEnvLoaded(): void {
	if (loaded) return;
	loaded = true;
	const file = resolve(appRoot, ".env");
	if (!existsSync(file)) return;
	for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!m) continue;
		const key = m[1];
		if (process.env[key] !== undefined) continue;
		let value = m[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}
