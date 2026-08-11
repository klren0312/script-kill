# 剧本杀（Script-Kill）生成与游玩系统

一个独立的剧本杀生成 + 单机游玩系统：

- **生成**：用 `@earendil-works/pi-agent-core` 的 Agent + `.agents/skills/jubensha-gen/SKILL.md` skill，由大模型生成符合 JSON Schema 的完整剧本，自动校验、重试、入库。
- **游玩**：玩家挑选剧本 → 选择自己要扮演的角色 → 其余角色交给独立 Agent（每人一个 `Agent`，自带私有设定与工具）。主持人（DM）由独立 Agent 担任，掌控真相并推进流程。
- **协议**：Fastify REST + SSE；前端为无框架的两页（剧本库 / 房间）。

## 架构

```
config/models.json          模型配置（provider / 角色用模型）
src/
  index.ts                  入口：加载配置 → 构建模型注册表 → 启动服务
  paths.ts                  各类目录路径
  config/models.ts          模型配置加载：支持内置 provider 与自定义 provider
  domain/schema.ts          剧本 JSON Schema（TypeBox）与校验
  domain/script-library.ts  剧本库存取 + 面向选角的安全视图
  agents/factory.ts         Agent 工厂（封装 pi-agent-core 的 Agent 构造）
  agents/generation.ts      剧本生成服务（skill + JSON 校验重试）
  game/types.ts             快照 / 事件 / 会话类型
  game/narrator.ts          主持人 prompt、真相、泄漏过滤
  game/tools.ts             角色 Agent 的 5 个工具（speak/whisper/investigate/show/vote）
  game/engine.ts            游戏引擎：状态机、回合循环、投票揭晓
  game/snapshots.ts         快照持久化与恢复
  server/index.ts           Fastify 实例（路由 + 静态文件）
  server/routes.ts          REST + SSE 路由
  server/games.ts           会话注册表 + 玩家视角公开快照
  server/sse.ts             SSE 客户端管理
public/                     前端页面（index.html / room.html）
scripts/generate-script.ts  CLI 生成剧本
data/scripts/               生成的剧本 JSON（git 忽略）
data/games/                 游戏会话快照（git 忽略）
```

## 运行

```bash
cd apps/script-kill
npm install
npm run dev      # tsx watch 启动，默认 http://127.0.0.1:3000
npm run check    # tsc --noEmit
npm run generate -- "题材描述" [玩家人数] [类型] [难度]   # CLI 生成剧本
```

## 模型配置

模型可配置且支持自定义模型。编辑 `config/models.json`：

```jsonc
{
	"providers": {
		// 内置 provider：留空即用 pi-ai 的 builtinModels 目录
		"anthropic": { "models": [] },
		// 自定义 provider：OpenAI 兼容端点
		"my-openai": {
			"baseUrl": "https://...",
			"api": "openai-completions",
			"apiKey": "$MY_API_KEY",        // 支持字面量 / $ENV_VAR / !command
			"models": [{ "id": "my-model", "name": "..." }]
		},
		// 自定义 provider：Anthropic 兼容端点（如 DeepSeek 网关）
		"deepseek-gw": {
			"baseUrl": "https://api.deepseek.com/anthropic",
			"api": "anthropic-messages",
			"apiKey": "$ANTHROPIC_AUTH_TOKEN",
			"models": [{ "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash" }]
		}
	},
	"roles": {
		"generator": { "provider": "ant-ling", "model": "Ling-3.0-flash", "thinkingLevel": "high" },
		"narrator":  { "provider": "ant-ling", "model": "Ling-3.0-flash", "thinkingLevel": "medium" },
		"player":    { "provider": "ant-ling", "model": "Ling-3.0-flash", "thinkingLevel": "low" }
	}
}
```

`apiKey` 支持字面量（如上例）、`$ENV_VAR`（环境变量）或 `!command`（执行命令取值）。**建议把密钥放到环境变量再以 `$...` 引用**，避免密钥随 `config/models.json` 进 git。

`ant-ling` 是 OpenAI 兼容端点（`https://api.ant-ling.com/v1/chat/completions`，模型 `Ling-3.0-flash`，本环境实测生成一个 3 人剧本约 20 秒）。`deepseek-gw` 走 DeepSeek 的 Anthropic 兼容网关（`https://api.deepseek.com/anthropic` + `$ANTHROPIC_AUTH_TOKEN`，模型 `deepseek-v4-flash`），作为备用 provider 保留在 `providers` 里，改 `roles` 即可切换。若你的环境有 Anthropic API key，把角色指回 `anthropic` 内置 provider 即可。

## 游戏流程

`setup → reading → discussion（多轮，每人每轮 1 次调查）→ voting → reveal`

- 真相与所有地点/公共线索只进入主持人的 prompt；每个角色的私密信息只进入该角色自己的 prompt。
- 主持人在揭晓前被硬性过滤：`leakCheck` 命中真凶名或手法词时自动改写。
- 投票：严格多数（> 半数有效票）投出真凶则好人获胜；平票视为未抓住真凶，凶手获胜。
- 每步操作后快照持久化到 `data/games/`，服务重启后可恢复并继续（`POST /api/games/:id/resume`）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/scripts` | 剧本卡片列表 |
| GET | `/api/scripts/:id` | 选角视图（无 secret/线索/真相） |
| POST | `/api/scripts/generate` | 生成剧本 `{topic, playerCount, genre?, difficulty?, id?}` |
| POST | `/api/games` | 建局 `{scriptId, humanRoleId}` → `{gameId, humanRole}` |
| GET | `/api/games/:id` | 玩家视角公开快照 |
| GET | `/api/games/:id/me` | 我的角色卡（含 secret 与线索文本） |
| GET | `/api/games/:id/events` | SSE 事件流（含重连快照） |
| POST | `/api/games/:id/start` | 开始游戏 |
| POST | `/api/games/:id/resume` | 恢复中断的 AI 回合 |
| POST | `/api/games/:id/action` | `{type: speak\|whisper\|investigate\|show\|endTurn, ...}` |
| POST | `/api/games/:id/vote` | `{target: roleId\|null}` |
