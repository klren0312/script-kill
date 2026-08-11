import { resolve } from "node:path";

/** apps/script-kill/ */
export const appRoot = resolve(import.meta.dirname, "..");
/** 剧本库目录（落盘的剧本 JSON） */
export const scriptsDir = resolve(appRoot, "data", "scripts");
/** 游戏会话快照目录 */
export const gamesDir = resolve(appRoot, "data", "games");
/** 项目内 .agents/skills 目录（技能已随项目独立维护） */
export const skillsDir = resolve(appRoot, ".agents", "skills");
/** 模型配置文件 */
export const configPath = resolve(appRoot, "config", "models.json");
/** 前端静态目录 */
export const publicDir = resolve(appRoot, "public");
