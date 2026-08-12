#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# 部署脚本：build → zip → scp → 服务器解压覆盖到 script-kill/
#
# 关键约束：服务器 script-kill/dist/data/ 不可被覆盖
#   （内含剧本与游戏快照，属运行时数据，应长期保留）
#
# 策略：打包时排除 dist/data/（本地构建的 data/ 是空目录），
#        服务器端解压后恢复原有 data/ 目录。
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER:-root@106.75.247.193}"
REMOTE_DEST="${REMOTE_DEST:-script-kill}"   # 服务器上目标目录（相对 $HOME）
ZIP_NAME="dist.zip"
BUILD_DIR=".deploy"

# 切到项目根目录（脚本位于 scripts/deploy.sh）
cd "$(dirname "$0")/.."

echo ""
echo "═══════════════════════════════════════════════════"
echo " 剧本杀 部署脚本"
echo " 目标服务器: $SERVER"
echo " 目标目录  : ~/$REMOTE_DEST"
echo "═══════════════════════════════════════════════════"

# ── 1. 构建 ──
echo ""
echo "[1/5] 构建 …"
npm run build --silent

if [ ! -d dist ]; then
    echo "错误: dist/ 目录不存在，构建可能失败。"
    exit 1
fi

# ── 2. 打包（排除 dist/data/） ──
echo "[2/5] 打包 $ZIP_NAME（排除 data/，防止覆盖服务器数据）…"

if ! command -v zip >/dev/null 2>&1; then
    echo "错误: 未找到 zip 命令。请安装 zip（如 Windows: scoop install zip 或 wsl）。"
    exit 1
fi

mkdir -p "$BUILD_DIR"
rm -f "$BUILD_DIR/$ZIP_NAME"

zip -r "$BUILD_DIR/$ZIP_NAME" dist/ -x "dist/data/*" "dist/data/" >/dev/null

echo "  → $BUILD_DIR/$ZIP_NAME ($(du -h "$BUILD_DIR/$ZIP_NAME" | cut -f1))"

# 验证：zip 内不应含 data/
echo "  校验 zip 内容（data/ 应被排除）…"
if unzip -l "$BUILD_DIR/$ZIP_NAME" 2>/dev/null | grep -q 'dist/data/'; then
    echo "警告: zip 内包含 data/ 目录，请检查打包逻辑。"
else
    echo "  ✓ data/ 已排除"
fi

# ── 3. 上传 ──
echo "[3/5] 上传到 $SERVER:~/"
scp "$BUILD_DIR/$ZIP_NAME" "$SERVER:~/" || {
    echo "scp 失败。请确认 SSH 连接正常。"
    exit 1
}

# ── 4. 服务器端部署 ──
echo "[4/5] 服务器端解压覆盖到 $REMOTE_DEST/（保留 dist/data/）…"

REMOTE_SCRIPT='.deploy-remote.sh'
# 用 sed 替换 __DEST__ 占位符，避免 heredoc 中 $HOME / $TEMP 被本地展开
sed "s/__DEST__/$REMOTE_DEST/g" > "$REMOTE_SCRIPT" << 'REMOTE_EOF'
#!/bin/bash
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
REMOTE_EOF

# 上传并执行远程脚本
scp "$REMOTE_SCRIPT" "$SERVER:~/" || {
    echo "scp 远程脚本失败。"
    rm -f "$REMOTE_SCRIPT"
    exit 1
}

ssh "$SERVER" "bash '$REMOTE_SCRIPT'"

# 清理
rm -f "$REMOTE_SCRIPT"
rm -f "$BUILD_DIR/$ZIP_NAME"

echo "[5/5] ✅ 部署完成"
echo ""
echo "  服务: $SERVER : ~/$REMOTE_DEST"
echo "  启动: ssh $SERVER \"cd ~/$REMOTE_DEST && node dist/index.js\""
echo ""