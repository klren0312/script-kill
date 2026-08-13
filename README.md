# 剧本杀（Script-Kill）生成与游玩系统

一个独立的剧本杀生成 + 单机游玩系统：

- **生成**：用 `@earendil-works/pi-agent-core` 的 Agent + `skills/jubensha-gen/SKILL.md` skill，由大模型生成符合 JSON Schema 的完整剧本，自动校验、重试、入库。
- **游玩**：玩家挑选剧本 → 选择自己要扮演的角色 → 其余角色交给独立 Agent（每人一个 `Agent`，自带私有设定与工具）。主持人（DM）由独立 Agent 担任，掌控真相并推进流程。
- **协议**：Fastify REST + SSE + WebSocket；SSE 供 Web 端（浏览器原生 `EventSource`），WebSocket 供小程序等非 SSE 客户端。

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
  game/store.ts             SQLite 持久层（pi-session-backend，快照读写 + 旧 JSON 兼容）
  server/index.ts           Fastify 实例（路由 + 静态文件）
  server/routes.ts          REST + SSE 路由
  server/games.ts           会话注册表 + 玩家视角公开快照
  server/sse.ts             SSE 客户端管理
  server/ws.ts             WebSocket 客户端管理（供小程序）
public/                     前端页面（index.html / room.html）
scripts/generate-script.ts  CLI 生成剧本
scripts/build.ts            打包构建（esbuild 内联依赖 → dist/，免装依赖部署）
data/scripts/               生成的剧本 JSON（git 忽略）
data/games/                 游戏库 sessions.sqlite + 旧版快照 JSON（git 忽略）
dist/                       构建产物（git 忽略，自包含可部署目录）
```

### 持久化

游戏持久化复用 `@earendil-works/pi-session-backend-sqlite-node`（基于 Node 内置 `node:sqlite`，无需原生依赖）：一个游戏 = 一个 SQLite session，每次状态变化以 custom entry 追加完整快照（append-only，最新一条即当前状态），引擎不再自写文件。后端自带跨进程单写者保护（writer lease），旧版 `data/games/*.json` 作为回退读取、恢复后自动迁移。

## 前端 / 移动端

前端为无框架的两页（`public/index.html` 剧本库 / `public/room.html` 房间），已做移动端适配：

- **视口**：`viewport-fit=cover` + `env(safe-area-inset-*)` 适配 iOS 刘海/底部安全区。
- **房间页移动端布局**（≤900px）：双栏变单栏，底部固定 Tab 栏（讨论 / 角色 / 行动 / 私聊）切换面板；聊天区占满主视口高度。
- **触控友好**：按钮最小高度 44px；输入框 `font-size: 16px` 防止 iOS 聚焦缩放；线索出示按钮加大触控区域。
- **响应式断点**：900px（单栏 + Tab 栏）、420px（收紧间距）、360px（Tab 栏图标换行）。
- **对话框**：打开时锁定 body 滚动（iOS 兼容）；小屏对话框更贴近全屏。

### 聊天交互增强（v0.x）

- **AI 润色按钮**：发言框和私聊框旁各有 ✨ 润色按钮，点击后 AI 实时替换输入内容为更流畅、自然的表述（不改变原意）。
- **调查加载反馈**：点击调查目标后，私密日志立即出现「调查中…」占位，等待服务端返回后自动替换为真实结果。
- **结束回合反馈**：点击结束回合并立即出现「结束回合中…」系统提示 Sard，等待结果后自动更新。
- **私聊即时反馈**：发送私聊后私密日志中立即显示「发送中…」，服务端返回后自动替换为最终内容。
- **Markdown 渲染**：聊天消息支持基础 Markdown — `**粗体**`、`*斜体*`、`> 引用`，与 HTML 转义混合使用，保证 XSS 安全。

### 游玩引导（Tour）

首次进入房间时自动弹出分步引导，沿游戏流程走一遍：

1. 🎭 欢迎 → 2. 📋 你的角色 → 3. ▶️ 开始游戏 → 4. 💬 讨论阶段 → 5. ⚔️ 行动面板 → 6. 🔍 私聊与调查 → 7. 🗳️ 投票阶段 → 8. 🎉 揭晓真相

- **引导形式**：桌面端为"聚光灯"高亮目标区域 + 引导卡片；移动端（≤900px）切换为居中模态卡片（高亮在移动端不可靠）。
- **不再提示**：关闭引导后写入 `localStorage.jubensha_tour_seen`，之后进入新房间不再弹出。顶栏 "?" 按钮可随时重播。
- **交互**：支持上一步/下一步/跳过/不再提示；点击遮罩或按 `Escape` 关闭。
- **实现**：纯前端自建组件（`public/room.js` 中 `Tour` 对象 + `public/style.css` Tour 样式），无外部依赖。

## 运行

```bash
cd apps/script-kill
npm install
npm run dev      # tsx watch 启动，默认 http://127.0.0.1:3000
npm run check    # tsc --noEmit
npm run generate -- "题材描述" [玩家人数] [类型] [难度]   # CLI 生成剧本
```

开发约定（架构细节、配置/密钥规范、提交流程）见项目根 `CLAUDE.md`。

## 打包部署（免装依赖）

`npm run build` 把代码 + 全部依赖打成自包含的 `dist/` 目录，服务器不需要再 `npm install`：

```bash
npm run build     # 产物：dist/
npm start         # 或本地直接跑源码
npm run start:prod  # = node dist/index.js
```

`dist/` 结构：

```
dist/
  index.js        服务器入口（esbuild 单文件 ESM，依赖全部内联）
  generate.js     CLI 生成剧本入口（node dist/generate.js "题材"）
  package.json    声明 ESM，node dist/index.js 可直接运行
  config/         模型配置（含 .env.example 模板）
  public/         前端页面
  skills/         生成用 skill
  migrations/     SQLite 迁移 SQL（运行时加载建表）
  data/           运行期剧本与游戏数据（初始为空；games/ 下为 sessions.sqlite）
```

部署到服务器：

```bash
# 一键部署（build → zip → scp → 服务器解压，data/ 自动保留）
./scripts/deploy.sh

# 自定义服务器 / 目标目录
SERVER=root@your-server REMOTE_DEST=my-app ./scripts/deploy.sh

# 或手动分步
npm run build
# 把整个 dist/ 拷贝到服务器，然后：
cp dist/.env.example dist/.env   # 在 dist/.env 里填真实 API key（模板已随包带出）
node dist/index.js               # 默认 http://127.0.0.1:3000，可用 PORT/HOST 覆盖
node dist/generate.js "古宅凶案"  # 或直接在服务器上生成剧本
```

**一键部署说明**（`scripts/deploy.ts`，`tsx scripts/deploy.ts`）：

1. 执行 `npm run build` 生成 `dist/`
2. 打包为 `dist.zip`，**自动排除 `dist/data/`**（本地构建的 data/ 是空目录，不含实际数据）
3. `scp dist.zip root@106.75.247.193:~` 上传到服务器
4. 服务器端：备份 `~/script-kill/dist/data/` → 解压覆盖 `~/script-kill/` → 恢复 data/
5. 部署完成后自动清理临时文件

> 通过环境变量可覆盖默认值：`SERVER`（默认 `root@106.75.247.193`）、`REMOTE_DEST`（默认 `script-kill`）。

**注意**：首次部署后，在服务器上配置 `~/script-kill/dist/.env`（复制 `dist/.env.example` 并填入真实 API key），后续部署不会覆盖 `dist/data/` 和 `dist/.env`（`.env` 不在构建产物中，不会被覆盖）。

要点：

- `dist/index.js` 已把 Node 依赖（fastify、pi-ai、pi-agent-core 等）全部打包内联，运行只需 Node ≥ 22.19（需内置 `node:sqlite`），不读 `node_modules`。SQLite 建表迁移 SQL 随构建复制到 `dist/migrations/`，运行时按 bundle 相对路径加载。
- 运行时目录由 `src/paths.ts` 自动定位：从 `index.js` 所在目录向上找 `config/models.json`，因此 `dist/` 放在任何路径都能自包含运行；也可用环境变量 `SCRIPT_KILL_ROOT` 显式指定根目录。
- API key 只放 `dist/.env`（或服务器环境变量），随构建复制的 `.env.example` 只是空模板，`dist/` 里不会带密钥。
- 已有剧本/游戏数据：把旧 `data/scripts/` 拷进 `dist/data/scripts/`；游戏数据把整个 `data/games/`（含 `sessions.sqlite`）拷进 `dist/data/games/` 即可。

## 模型配置

模型可配置且支持自定义模型。编辑 `config/models.json`：

```jsonc
{
  "providers": {
    // 内置 provider：留空即用 pi-ai 的 builtinModels 目录（无 baseUrl，无需 provider 字段）
    "anthropic": { "models": [] },
    // 自定义 provider：OpenAI 兼容端点（有 baseUrl 必须声明 provider 字符串，值自定义即可）
    "my-openai": {
      "provider": "my-openai",
      "baseUrl": "https://...",
      "api": "openai-completions",
      "apiKey": "$MY_API_KEY", // 支持字面量 / $ENV_VAR / !command
      "models": [{ "id": "my-model", "name": "..." }],
    },
    // 自定义 provider：Anthropic 兼容端点（如 DeepSeek 网关）
    "deepseek-gw": {
      "provider": "deepseek-gw",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "api": "anthropic-messages",
      "apiKey": "$ANTHROPIC_AUTH_TOKEN",
      "models": [{ "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash" }],
    },
    // 自定义 provider：ant-ling（OpenAI 兼容）
    "ant-ling": {
      "provider": "ant-ling",
      "baseUrl": "https://api.ant-ling.com/v1",
      "api": "openai-completions",
      "apiKey": "$ANT_LING_API_KEY",
      "models": [{ "id": "Ling-3.0-flash", "name": "Ling 3.0 Flash" }],
    },
  },
  "roles": {
    "generator": {
      "provider": "ant-ling",
      "model": "Ling-3.0-flash",
      "thinkingLevel": "high",
    },
    "narrator": {
      "provider": "ant-ling",
      "model": "Ling-3.0-flash",
      "thinkingLevel": "medium",
    },
    "player": {
      "provider": "ant-ling",
      "model": "Ling-3.0-flash",
      "thinkingLevel": "low",
    },
  },
}
```

`apiKey` 支持字面量（如上例）、`$ENV_VAR`（环境变量）或 `!command`（执行命令取值）。**建议把密钥放到环境变量再以 `$...` 引用**，避免密钥随 `config/models.json` 进 git。

**环境变量配置文件**：项目在启动时自动加载根目录 `.env`（见 `.env.example` 模板，复制成 `.env` 填入真实值即可；`.env` 已被 git 忽略）。优先级为 系统环境变量 > `.env`。例如 ant-ling 的 key 填 `ANT_LING_API_KEY=...`，config 里写 `"apiKey": "$ANT_LING_API_KEY"` 即自动生效。

`ant-ling` 是 OpenAI 兼容端点（`https://api.ant-ling.com/v1/chat/completions`，模型 `Ling-3.0-flash`，本环境实测生成一个 3 人剧本约 20 秒）。`deepseek-gw` 走 DeepSeek 的 Anthropic 兼容网关（`https://api.deepseek.com/anthropic` + `$ANTHROPIC_AUTH_TOKEN`，模型 `deepseek-v4-flash`），作为备用 provider 保留在 `providers` 里，改 `roles` 即可切换。若你的环境有 Anthropic API key，把角色指回 `anthropic` 内置 provider 即可。

## 游戏流程

`setup → reading → discussion（多轮，每人每轮 1 次调查）→ voting → reveal`

- 真相与所有地点/公共线索只进入主持人的 prompt；每个角色的私密信息只进入该角色自己的 prompt。
- AI 角色用 `speak` 工具公开发言，工具的 `content` 参数即为唯一入记录的台词；模型 tool 调用后附带的旁白/策略备注（"心声"）不进入公开记录。
- 主持人在揭晓前被硬性过滤：`leakCheck` 命中真凶名或手法词时自动改写。
- 投票：严格多数（> 半数有效票）投出真凶则好人获胜；平票视为未抓住真凶，凶手获胜。
- 每步操作后完整快照追加写入 SQLite（`data/games/sessions.sqlite`，一个游戏一个 session），服务重启后可恢复并继续（`POST /api/games/:id/resume`）；旧版 `data/games/*.json` 快照仍可读取，恢复后首次持久化自动迁移进 SQLite。

## API 一览

| 方法 | 路径                       | 说明                                                      |
| ---- | -------------------------- | --------------------------------------------------------- |
| GET  | `/api/scripts`             | 剧本卡片列表                                              |
| GET  | `/api/scripts/:id`         | 选角视图（无 secret/线索/真相）                           |
| POST | `/api/scripts/generate`    | 生成剧本 `{topic, playerCount, genre?, difficulty?, id?}` |
| POST | `/api/games`               | 建局 `{scriptId, humanRoleId}` → `{gameId, humanRole}`    |
| GET  | `/api/games/:id`           | 玩家视角公开快照                                          |
| GET  | `/api/games/:id/me`        | 我的角色卡（含 secret 与线索文本）                        |
| GET  | `/api/games/:id/events`    | SSE 事件流（含重连快照）                                  |
| POST | `/api/games/:id/start`     | 开始游戏                                                  |
| POST | `/api/games/:id/resume`    | 恢复中断的 AI 回合                                        |
| POST | `/api/games/:id/action`    | `{type: speak\|whisper\|investigate\|show\|endTurn, ...}` |
| POST | `/api/games/:id/vote`      | `{target: roleId\|null}`                                  |
| POST | `/api/games/:id/polish`    | `{text: string}` → `{polished: string}`（AI 润色文本）    |
| WS   | `/ws/games/:id?roleId=xxx` | WebSocket 事件推送（供小程序，下行帧与 SSE 同构）         |

## WebSocket（小程序对接）

Web 端用 SSE（浏览器原生 `EventSource`），但微信小程序等无法对接 SSE，因此提供 WebSocket 端点。SSE 与 WS 双传输并存，互不干扰。

**连接**

```
ws://<host>:<port>/ws/games/:gameId?roleId=<humanRoleId>
```

- `gameId`：通过 `POST /api/games` 建局后拿到的 `id`。
- `roleId`：query 参数，必填。用于私密事件过滤（只推 public 事件 + 发给该玩家的私密事件）。缺省则服务端立即断开连接。
- 小程序用 `wx.connectSocket({ url })`，无 cookie 场景下所有上下文走 URL。

**下行帧（与 SSE 完全同构）**

连接建立后服务端**立即推送一条 `snapshot` 帧**，格式与 SSE 的 `data:` 行一致，便于重连/刷新恢复界面：

```json
{
  "type": "snapshot",
  "snapshot": {
    /* PublicSnapshot */
  }
}
```

之后收到的帧与 SSE 事件一一对应，`type` 取值：

| type          | 说明         |
| ------------- | ------------ |
| `phase`       | 阶段切换     |
| `turn`        | 回合切换     |
| `speak`       | 公开发言     |
| `whisper`     | 私聊（私密） |
| `investigate` | 调查（私密） |
| `show`        | 出示线索     |
| `vote`        | 投票         |
| `narrator`    | 主持人旁白   |
| `system`      | 系统提示     |
| `game_end`    | 揭晓结果     |

客户端按 `ev.type` 分发即可，与 `room.html` 的 `handleEvent` 逻辑一致。

**动作用于 HTTP（不走 WS）**

发言、私聊、调查、投票、润色等动作仍走 `POST /api/games/:id/action`、`/vote`、`/polish` 等 HTTP 路由（复用鉴权、校验、串行化、快照持久化）。WS 仅负责事件下行推送。

**重连与恢复**

小程序 `wx.connectSocket` 无自动重连，需自行实现：

1. 监听 `onClose` / `onError`，断线后循环 `connectSocket`。
2. 重连成功后服务端会再次推送 `snapshot` 帧，客户端拿到后全量重建界面（`rebuildLogs()`），无需服务端缓存 missed events。

**作用域说明**

WS 按 game 分桶（与 SSE 一致），过滤在 `broadcast` 内部完成：仅 `scope === "public"` 或 `scope === humanRoleId` 的事件被推送。其余私密事件（其他 AI 角色之间的私聊、其他人的调查）不会被发送。

## 架构（含 WS）

`src/server/ws.ts` — `WsHub`，结构镜像 `SseHub`，管理 WebSocket 连接集合并按 game 分桶广播。`@fastify/websocket` 插件挂载在 Fastify 实例上，WS 路由定义在 `routes.ts`。游戏引擎 `GameEngine` 与 `EventType` 等对传输层无感知，`onEvent` 回调同时 fan-out 到 SSE 和 WS。
