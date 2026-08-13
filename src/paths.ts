import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * 定位项目根目录：
 * - 源码运行（tsx）：`src/` 或 `scripts/` 的上级能找到 `config/models.json` → 项目根。
 * - 打包产物（`npm run build` 出的 `dist/index.js`）：`dist/` 内已复制 `config/models.json` → 直接命中 `dist/`，实现自包含部署（服务器无需安装依赖）。
 * 可用环境变量 `SCRIPT_KILL_ROOT` 显式指定（如部署在其它目录时）。
 */
function detectAppRoot(): string {
	const explicit = process.env.SCRIPT_KILL_ROOT;
	if (explicit) return resolve(explicit);
	let dir = import.meta.dirname;
	for (;;) {
		if (existsSync(resolve(dir, "config", "models.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break; // 已到文件系统根，兜底
		dir = parent;
	}
	return resolve(import.meta.dirname, "..");
}

/** apps/script-kill/（源码=项目根；打包产物=dist/） */
export const appRoot = detectAppRoot();
/** 剧本库目录（落盘的剧本 JSON） */
export const scriptsDir = resolve(appRoot, "data", "scripts");
/** 游戏会话快照目录 */
export const gamesDir = resolve(appRoot, "data", "games");
/** 项目内 skills 目录（技能已随项目独立维护） */
export const skillsDir = resolve(appRoot, "skills");
/** 模型配置文件 */
export const configPath = resolve(appRoot, "config", "models.json");
/** 前端静态目录 */
export const publicDir = resolve(appRoot, "public");
