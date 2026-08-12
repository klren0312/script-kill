import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { appRoot } from "../src/paths.js";

// 所有命令均使用系统默认 shell（Windows 下为 PowerShell/cmd），不再强制
// bash。PowerShell 环境中 ssh / scp / 7z 均已在 PATH 中，无需额外 shell。
const LOCAL_SHELL: string | undefined = undefined;
const REMOTE_SHELL: string | undefined = undefined;

/**
 * 一键部署脚本：build → zip → scp → 服务器解压覆盖到 script-kill/
 *
 * 关键约束：服务器 script-kill/dist/data/ 不可被覆盖
 *   （内含剧本与游戏快照，属运行时数据，应长期保留）
 *
 * 策略：打包时排除 dist/data/（本地构建的 data/ 是空目录），
 *       服务器端解压后恢复原有 data/ 目录。
 *
 * 环境变量覆盖：SERVER=xxx REMOTE_DEST=yyy tsx scripts/deploy.ts
 */

const SERVER = process.env.SERVER ?? "root@106.75.247.193";
const REMOTE_DEST = process.env.REMOTE_DEST ?? "script-kill";
const ZIP_NAME = "dist.zip";
const BUILD_DIR = resolve(appRoot, ".deploy");
const ZIP_PATH = resolve(BUILD_DIR, ZIP_NAME);
const REMOTE_SCRIPT = ".deploy-remote.sh";

console.log("");
console.log("═══════════════════════════════════════════════════");
console.log(" 剧本杀 部署脚本");
console.log(` 目标服务器: ${SERVER}`);
console.log(` 目标目录  : ~/${REMOTE_DEST}`);
console.log("═══════════════════════════════════════════════════");

// ── 1. 构建 ──
console.log("\n[1/5] 构建 …");
execSync("npm run build --silent", { stdio: "inherit", cwd: appRoot, shell: LOCAL_SHELL });

if (!existsSync(resolve(appRoot, "dist"))) {
	console.log("错误: dist/ 目录不存在，构建可能失败。");
	process.exit(1);
}

// ── 2. 打包（排除 dist/data/） ──
console.log(`[2/5] 打包 ${ZIP_NAME}（排除 data/，防止覆盖服务器数据）…`);

// 检查 7z 是否可用
try {
	execSync("7z --help", { stdio: "ignore", shell: LOCAL_SHELL });
} catch {
	console.log("错误: 未找到 7z 命令。请安装 7-Zip（Windows: scoop install 7zip 或官网下载，并确保 7z 在 PATH 中）。");
	process.exit(1);
}

mkdirSync(BUILD_DIR, { recursive: true });
rmSync(ZIP_PATH, { force: true });

// 7z a <zip> dist/ -x!dist/data/*
execSync(`7z a "${ZIP_PATH}" dist/ -x!dist/data/* -x!dist/data/`, { stdio: "inherit", cwd: appRoot, shell: LOCAL_SHELL });

// 校验：7z 内不应含 dist/data/
console.log("  校验 zip 内容（data/ 应被排除）…");
try {
	const zipList = execSync(`7z l "${ZIP_PATH}"`, {
		cwd: appRoot,
		encoding: "utf8",
		shell: LOCAL_SHELL,
	})
		.toLowerCase()
		.replace(/\\/g, "/");
	if (zipList.includes("dist/data/")) {
		console.log("警告: zip 内包含 data/ 目录，请检查打包逻辑。");
	} else {
		console.log("  ✓ data/ 已排除");
	}
} catch {
	console.log("  (跳过校验：未找到 7z 命令)");
}

// ── 3. 上传 ──
console.log(`[3/5] 上传到 ${SERVER}:~/`);
execSync(`scp "${ZIP_PATH}" "${SERVER}:~/"`, { stdio: "inherit", shell: REMOTE_SHELL });

// ── 4. 服务器端部署 ──
console.log(`[4/5] 服务器端解压覆盖到 ${REMOTE_DEST}/（保留 dist/data/）…`);

// 生成远程脚本（用 __DEST__ 占位符，替换为实际值）
const remoteScript = `#!/bin/bash
set -e
DEST="$HOME/__DEST__"
TEMP="$HOME/.deploy-tmp-$$"
rm -rf "$TEMP"
mkdir -p "$TEMP"
trap "rm -rf $TEMP" EXIT

echo "  服务器端: 目标 $DEST"

# 备份 data 目录（若存在且非空）
if [ -d "$DEST/dist/data" ] && [ "$(ls -A "$DEST/dist/data/" 2>/dev/null)" ]; then
    echo "  备份 data/ ..."
    cp -a "$DEST/dist/data" "$TEMP/data"
else
    echo "  data/ 不存在或为空，跳过备份"
fi

# 清理旧 dist 并解压
if [ -d "$DEST/dist" ]; then
    rm -rf "$DEST/dist"
fi
unzip -o "$HOME/dist.zip" -d "$DEST" >/dev/null
rm -f "$HOME/dist.zip"

# 恢复 data；若不存在则初始化空目录
if [ -d "$TEMP/data" ]; then
    cp -a "$TEMP/data" "$DEST/dist/data"
    echo "  data/ 已恢复"
else
    mkdir -p "$DEST/dist/data/scripts" "$DEST/dist/data/games"
    echo "  data/ 目录已创建（首次部署）"
fi

echo "  服务器部署完成"

# 重启服务（确保 cwd 始终落在存在的目录，避免 pm2/npm 报 process.cwd 失败）
cd "$HOME"
if command -v pm2 >/dev/null 2>&1; then
    cd "$DEST/dist"
    pm2 restart 0
    echo "  服务已通过 pm2 重启"
else
    echo "  警告: 未找到 pm2，请手动重启服务: cd ~/${REMOTE_DEST}/dist && pm2 restart 0"
fi
`;

const remoteScriptFinal = remoteScript.replaceAll("__DEST__", REMOTE_DEST);

// 写临时远程脚本到 .deploy/ 目录，scp 上去后执行
const remoteScriptPath = resolve(BUILD_DIR, REMOTE_SCRIPT);
writeFileSync(remoteScriptPath, remoteScriptFinal);

try {
	execSync(`scp "${remoteScriptPath}" "${SERVER}:~/"`, { stdio: "inherit", shell: REMOTE_SHELL });
	execSync(`ssh "${SERVER}" "bash '${REMOTE_SCRIPT}'"`, { stdio: "inherit", shell: REMOTE_SHELL });
} finally {
	rmSync(remoteScriptPath, { force: true });
}

// 清理
rmSync(ZIP_PATH, { force: true });
rmSync(BUILD_DIR, { force: true, recursive: true });

// ── 5. 重启服务 ──
console.log(`[5/5] 重启服务 …`);
execSync(`ssh "${SERVER}" "cd \\"$HOME\\" && cd ~/${REMOTE_DEST}/dist && pm2 restart 0"`, { stdio: "inherit", shell: REMOTE_SHELL });

console.log("✅ 部署完成");
console.log("");
console.log(`  服务: ${SERVER} : ~/${REMOTE_DEST}`);
console.log("");