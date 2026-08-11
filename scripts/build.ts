import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appRoot } from "../src/paths.js";

/**
 * 打包构建：把代码 + 全部依赖打成 `dist/`，服务器无需再 `npm install`。
 *
 * - `dist/index.js`    服务器入口（esbuild 单文件 ESM，依赖全部内联）
 * - `dist/generate.js` CLI 生成剧本入口（同样内联）
 * - `dist/config/ public/ .agents/`  运行时资源（模型配置 / 前端 / skill）
 * - `dist/data/`       运行期剧本与游戏快照目录（初始为空）
 * - `dist/package.json` 声明 ESM，使 `node dist/index.js` 可直接运行
 *
 * 部署：把整个 `dist/` 拷贝到服务器，在 `dist/.env` 填好 API key（模板已复制），
 * `node dist/index.js`（或 `node dist/generate.js "题材"`）。
 */

const dist = resolve(appRoot, "dist");

/**
 * ESM 输出下，CJS 依赖（fastify/avvio 等）里的动态 `require()`（如 `require("node:events")`）
 * 无法被静态内联；通过 banner 注入 `createRequire`，让这类动态 require 在运行时按
 * 相对 dist/index.js 的 node 解析规则工作。实测必需，否则启动即抛
 * `Error: Dynamic require of "node:events" is not supported`。
 */
const banner = `import { createRequire as __skCreateRequire } from "node:module"; const require = __skCreateRequire(import.meta.url);`;

const esbuildOptions = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	sourcemap: true,
	banner: { js: banner },
	logLevel: "info",
} as const;

console.log("[build] 清空并重建 dist/ ...");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log("[build] 打包服务器 src/index.ts -> dist/index.js");
await build({
	...esbuildOptions,
	entryPoints: [resolve(appRoot, "src", "index.ts")],
	outfile: resolve(dist, "index.js"),
});

console.log("[build] 打包 CLI scripts/generate-script.ts -> dist/generate.js");
await build({
	...esbuildOptions,
	entryPoints: [resolve(appRoot, "scripts", "generate-script.ts")],
	outfile: resolve(dist, "generate.js"),
});

console.log("[build] 复制运行时资源 config/ public/ .agents/ ...");
for (const dir of ["config", "public", ".agents"]) {
	cpSync(resolve(appRoot, dir), resolve(dist, dir), { recursive: true });
}
cpSync(resolve(appRoot, ".env.example"), resolve(dist, ".env.example"), { force: true });

console.log("[build] 初始化空 data/ 目录 ...");
for (const sub of ["scripts", "games"]) {
	mkdirSync(resolve(dist, "data", sub), { recursive: true });
	writeFileSync(resolve(dist, "data", sub, ".gitkeep"), "");
}

writeFileSync(
	resolve(dist, "package.json"),
	JSON.stringify({ name: "script-kill-dist", private: true, type: "module", main: "index.js" }, null, 2) + "\n",
);

console.log("[build] 完成 ✅ 部署：拷贝 dist/ 到服务器 -> 配置 dist/.env -> node dist/index.js");
