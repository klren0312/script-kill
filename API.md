# 剧本杀（Script-Kill）服务端 API 文档

> 版本：`v0.1.0`（与 `package.json` 同步）。所有接口路径前缀为 `/api`。
> 协议：Fastify REST（JSON）+ SSE（Server-Sent Events）+ WebSocket。`room.html` 通过 SSE 接收实时事件；小程序等非 SSE 客户端通过 WebSocket。

---

## 目录

1. [环境配置](#1-环境配置)
2. [鉴权方式](#2-鉴权方式)
3. [通用约定](#3-通用约定)
4. [错误码定义](#4-错误码定义)
5. [接口详情](#5-接口详情)
   - [健康检查](#51-get-apihealth)
   - [剧本库](#52-剧本库)
   - [游戏会话](#53-游戏会话)
   - [SSE 事件流](#54-sse-事件流)
   - [WebSocket 事件流（小程序）](#55-websocket-事件流小程序)
6. [数据模型](#6-数据模型)
7. [版本与变更记录](#7-版本与变更记录)

---

## 1. 环境配置

### 1.1 基础运行参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（`0.0.0.0` 对外暴露；开发期可用 `127.0.0.1`） |
| `SCRIPT_KILL_ROOT` | 自动推导 | 项目根目录（默认从可执行文件向上查找 `config/models.json`）；也可用此变量显式指定 |

### 1.2 启动命令

```bash
npm install
npm run dev        # tsx watch，开发模式
npm start          # tsx 单次启动
npm run build      # 打包为自包含 dist/（免装依赖部署）
node dist/index.js # 生产启动（PORT/HOST 可覆盖）
```

### 1.3 模型与密钥配置

模型在 `config/models.json` 配置，密钥通过 `.env`（git 忽略）的 `$ENV_VAR` 引用，例如：

```jsonc
// config/models.json
{
  "roles": {
    "generator": { "provider": "ant-ling", "model": "Ling-3.0-flash", "thinkingLevel": "high" },
    "narrator":  { "provider": "sensenova", "model": "deepseek-v4-flash", "thinkingLevel": "medium" },
    "player":    { "provider": "openrouter", "model": "openrouter/free", "thinkingLevel": "medium" }
  }
}
```

```bash
# .env（勿提交）
ANT_LING_API_KEY=...
ANTHROPIC_AUTH_TOKEN=...
OPENROUTER_API_KEY=...
SENSENOVA_API_KEY=...
```

> 密钥优先级：系统环境变量 > `.env`。`apiKey` 支持字面量 / `$ENV_VAR` / `!command`，**建议只放 `$ENV_VAR`**，避免密钥进 git。

### 1.4 环境地址示例

| 环境 | Base URL |
| --- | --- |
| 本地开发 | `http://127.0.0.1:3000` |
| 预发/生产 | 由部署方提供的 `http(s)://<HOST>:<PORT>` |

---

## 2. 鉴权方式

> ⚠️ **当前版本（v0.1.0）未实现任何鉴权机制。** 服务端不校验身份、不签发令牌，所有 `/api/*` 接口对网络可达方开放。
> 以下为**接入时的安全须知与后续升级建议**，客户端不要在生产环境直接暴露于公网。

- **现状**：无 API Key、无 Token、无 CORS 限制（同源策略由浏览器默认生效；跨域需自行在部署层配置）。
- **部署建议**：
  - 在反向代理（Nginx / 网关）层添加鉴权（如 `Authorization: Bearer <token>`）。
  - 仅对内网或可信网络开放，避免剧本生成接口被滥用（每次生成会消耗 LLM 额度）。
- **后续规划**：下个版本（v0.2.0）计划在 `routes.ts` 注册 `onRequest` 钩子，统一校验 `Authorization` 头；届时本文档会更新鉴权章节。

---

## 3. 通用约定

### 3.1 请求

- 所有请求/响应体均为 `application/json`（除 SSE 为 `text/event-stream`）。
- 请求体（POST）需带 `Content-Type: application/json`。
- 路径参数（如 `:id`）为字符串（游戏 ID 使用 uuidv7，剧本 ID 为生成时指定）。

### 3.2 响应包装

- 成功响应通常返回业务对象（无统一 `data` 包裹）。
- 失败响应统一为 `{ "error": "消息" }`，并带对应 HTTP 状态码（见错误码表）。

### 3.3 时间字段

- 所有 `*At` 字段为 Unix 毫秒时间戳（`number`），例如 `createdAt`、`updatedAt`、`at`。

### 3.4 游戏阶段（Phase）

```ts
type Phase = "setup" | "reading" | "discussion" | "voting" | "reveal" | "finished";
```

- `setup` → `reading`（建局后）→ `discussion`（多轮，每轮每人 1 次调查）→ `voting` → `reveal` → `finished`。

---

## 4. 错误码定义

服务端使用标准 HTTP 状态码 + `{ error: string }` 消息体。无自定义数字业务错误码。

| HTTP 状态码 | 含义 | 触发场景 | 返回示例 |
| --- | --- | --- | --- |
| `200` | 成功 | 正常处理 | 业务对象 |
| `400` | 请求参数错误 / 业务前置条件不满足 | 缺必填字段、游戏状态不允许该操作、未知行动类型 | `{ "error": "需要 topic（题材/背景）" }` |
| `404` | 资源不存在 | 剧本 ID / 游戏 ID / 角色不存在 | `{ "error": "剧本 xxx 不存在" }` |
| `500` | 服务端内部错误 | 剧本生成失败、LLM 调用异常等 | `{ "error": "<异常信息>" }` |

### 4.1 常见业务错误消息

| 消息 | 含义 |
| --- | --- |
| `需要 topic（题材/背景）` | `POST /api/scripts/generate` 缺 `topic` |
| `需要 scriptId 与 humanRoleId` | `POST /api/games` 缺参数 |
| `剧本 xxx 不存在` | 指定剧本未入库 |
| `剧本中没有角色 xxx` | `humanRoleId` 不在剧本角色列表 |
| `游戏 xxx 不存在` | 游戏会话未找到（内存+磁盘均无） |
| `需要 type` | `POST /api/games/:id/action` 缺 `type` |
| `需要 text` | `POST /api/games/:id/polish` 缺 `text` |
| `现在不是你的回合` | 非当前回合角色发起行动 |
| `未知行动 xxx` | `action.type` 非法 |
| `本回合已调查过` | 当前回合已调查，不可重复 |
| `未持有线索 xxx` | `show` 出示未拥有的线索 |
| `现在不是投票阶段` | 非 `voting` 阶段调用投票 |
| `你已经投过票了` | 人类玩家重复投票 |

---

## 5. 接口详情

### 5.1 GET /api/health

健康检查。

- **鉴权**：无
- **参数**：无
- **返回** `200`：

```json
{ "ok": true }
```

---

### 5.2 剧本库

#### 5.2.1 GET /api/scripts

获取剧本卡片列表（用于剧本库页展示）。

- **鉴权**：无
- **参数**：无
- **返回** `200`：`ScriptCard[]`

```json
[
  {
    "id": "murder-at-manor",
    "title": "古宅凶案",
    "genre": "悬疑",
    "description": "一个风雪之夜，古宅中发生了命案……",
    "playerCount": 5,
    "estimatedMinutes": 90,
    "difficulty": "中等"
  }
]
```

`ScriptCard` 字段见 [6.1](#61-scriptcard)。

---

#### 5.2.2 GET /api/scripts/:id

获取剧本选角视图（**不含** secret / 线索原文 / 真相，安全供玩家选角）。

- **鉴权**：无
- **路径参数**：`id` — 剧本 ID
- **返回** `200`：`ScriptSelectView`；`404`：剧本不存在

```json
{
  "id": "murder-at-manor",
  "title": "古宅凶案",
  "genre": "悬疑",
  "description": "……",
  "difficulty": "中等",
  "playerCount": 5,
  "estimatedMinutes": 90,
  "setting": {
    "time": "1930 年冬夜",
    "place": "郊外古宅",
    "background": "一场暴风雪困住了六位访客……"
  },
  "roles": [
    { "id": "r1", "name": "管家", "public": "在此工作二十年", "goal": "隐藏自己的过去" }
  ],
  "locations": [
    { "id": "l1", "name": "书房", "description": "壁炉旁的桌椅……" }
  ],
  "publicClues": [
    { "id": "c1", "text": "一封未被寄出的信" }
  ]
}
```

`ScriptSelectView` 字段见 [6.2](#62-scriptselectview)。

---

#### 5.2.3 POST /api/scripts/generate

由大模型生成剧本（HTTP 生成**不带** story 优化，约 16s 响应）。生成后自动入库，返回卡片与选角视图。

- **鉴权**：无
- **请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `topic` | string | 是 | 题材 / 背景描述 |
| `playerCount` | number | 否 | 玩家人数，默认 `5` |
| `genre` | string | 否 | 类型（如「悬疑」「欢乐」） |
| `difficulty` | string | 否 | 难度（如「中等」） |
| `id` | string | 否 | 指定剧本 ID（不填则自动生成） |

- **返回** `200`：

```json
{
  "card": { "ScriptCard 结构见 6.1" },
  "select": { "ScriptSelectView 结构见 6.2" }
}
```

- **错误**：`400` 缺 `topic`；`500` 生成失败（`{ "error": "<异常>" }`）

**调用示例**：

```bash
curl -X POST http://127.0.0.1:3000/api/scripts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "一个与世隔绝的雪山大酒店里的连环命案",
    "playerCount": 6,
    "genre": "本格推理",
    "difficulty": "困难"
  }'
```

---

### 5.3 游戏会话

#### 5.3.1 GET /api/games

列出所有已创建游戏会话。

- **鉴权**：无
- **参数**：无
- **返回** `200`：

```json
[
  {
    "id": "01J9X...uuid",
    "scriptId": "murder-at-manor",
    "phase": "discussion",
    "updatedAt": 1723456789012
  }
]
```

---

#### 5.3.2 POST /api/games

创建一局游戏，人类玩家扮演指定角色，其余角色由 AI Agent 接管。

- **鉴权**：无
- **请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `scriptId` | string | 是 | 剧本 ID（须已入库） |
| `humanRoleId` | string | 是 | 人类玩家扮演的角色 ID |

- **返回** `200`：

```json
{
  "gameId": "01J9X...uuid",
  "humanRole": {
    "role": {
      "id": "r1",
      "name": "管家",
      "public": "在此工作二十年",
      "secret": "其实你当晚去过书房",
      "goal": "隐藏自己的过去",
      "relationships": { "r2": "与女主人关系紧张" }
    },
    "clueTexts": [
      { "id": "c1", "text": "一封未被寄出的信" }
    ],
    "publicClues": [
      { "id": "c1", "text": "一封未被寄出的信" }
    ]
  }
}
```

- **错误**：`400` 缺参数 / 剧本或角色不存在

**调用示例**：

```bash
curl -X POST http://127.0.0.1:3000/api/games \
  -H "Content-Type: application/json" \
  -d '{ "scriptId": "murder-at-manor", "humanRoleId": "r1" }'
```

> 客户端应保存 `gameId`，用于后续所有 `/api/games/:id/*` 请求，并通过 SSE（Web 端）或 WS（小程序）监听实时事件。

---

#### 5.3.3 GET /api/games/:id

获取当前玩家视角的公开快照（不含 AI 角色私密事件 / 转录）。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **返回** `200`：`PublicSnapshot`（结构见 [6.3](#63-publicsnapshot)）；`404` 游戏不存在

**调用示例**：

```bash
curl http://127.0.0.1:3000/api/games/01J9X...uuid
```

---

#### 5.3.4 GET /api/games/:id/me

获取「我」的角色卡，含私密信息（secret）与可出示线索原文。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **返回** `200`：

```json
{
  "role": {
    "id": "r1",
    "name": "管家",
    "public": "在此工作二十年",
    "secret": "其实你当晚去过书房",
    "goal": "隐藏自己的过去",
    "relationships": { "r2": "与女主人关系紧张" }
  },
  "clueTexts": [
    { "id": "c1", "text": "一封未被寄出的信" }
  ],
  "publicClues": [
    { "id": "c1", "text": "一封未被寄出的信" }
  ]
}
```

- **错误**：`404` 游戏不存在 / 角色不存在

> ⚠️ 该接口返回**最高敏感数据**（secret + 全部线索），仅在玩家本人房间页使用，切勿缓存或暴露给他人。

---

#### 5.3.5 POST /api/games/:id/start

开始游戏（从 `reading` → `discussion`，主持人开场）。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **请求体**：无
- **返回** `200`：`{ "ok": true }`；`400` 游戏不在待开始状态

```bash
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/start
```

> 开始后会通过 SSE / WS 推送 `narrator`（开场白）、`turn`（轮到谁）、AI 角色发言等事件。

---

#### 5.3.6 POST /api/games/:id/resume

恢复中断的 AI 回合（服务重启后调用，重跑停留的 AI 回合或推进流程）。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **请求体**：无
- **返回** `200`：`{ "ok": true }`；`400` 异常

```bash
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/resume
```

---

#### 5.3.7 POST /api/games/:id/action

人类玩家行动。所有行动要求「当前是你的回合」（`currentTurn === humanRoleId`）。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **请求体**（通用字段）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | `speak` \| `whisper` \| `investigate` \| `show` \| `endTurn` |
| `content` | string | 视 type | `speak`/`whisper` 的发言内容 |
| `target` | string | 视 type | `whisper` 目标角色 ID；`investigate` 目标（角色 ID 或地点 ID） |
| `clueId` | string | `show` 必填 | 出示的线索 ID（须为本人持有） |

- **返回** `200`：`{ "ok": true }`；`400` 校验/状态错误

| `type` | 额外必填 | 说明 | 推送到 SSE / WS |
| --- | --- | --- | --- |
| `speak` | `content` | 公开发言 | `speak` 事件 |
| `whisper` | `target`,`content` | 私聊某角色（仅双方可见） | `whisper`（私密事件，仅对应角色收到） |
| `investigate` | `target` | 调查角色/地点（每回合限 1 次） | `investigate`（私密事件，仅本人收到） |
| `show` | `clueId` | 出示本人持有的线索 | `show` 事件（公开） |
| `endTurn` | — | 结束本回合，推进流程 | `turn` / `narrator` / `phase` 等 |

**调用示例**：

```bash
# 公开发言
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/action \
  -H "Content-Type: application/json" \
  -d '{ "type": "speak", "content": "我昨晚听到书房有动静。" }'

# 私聊角色 r2
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/action \
  -H "Content-Type: application/json" \
  -d '{ "type": "whisper", "target": "r2", "content": "你知道些什么？" }'

# 调查地点 l1
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/action \
  -H "Content-Type: application/json" \
  -d '{ "type": "investigate", "target": "l1" }'

# 出示线索 c1
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/action \
  -H "Content-Type: application/json" \
  -d '{ "type": "show", "clueId": "c1" }'

# 结束回合
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/action \
  -H "Content-Type: application/json" \
  -d '{ "type": "endTurn" }'
```

---

#### 5.3.8 POST /api/games/:id/vote

投出真凶（或弃权）。仅 `voting` 阶段有效，每人限投一次。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `target` | string \| null | 否 | 真凶角色 ID；`null` 或空字符串/缺省表示弃权 |

- **返回** `200`：`{ "ok": true }`；`400` 非投票阶段/已投票/目标无效

```bash
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/vote \
  -H "Content-Type: application/json" \
  -d '{ "target": "r3" }'

# 弃权
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/vote \
  -H "Content-Type: application/json" \
  -d '{ "target": null }'
```

> 当所有玩家（含 AI）投票完成，服务端自动揭晓（推送 `game_end` 事件，含 `winner` 与 `truth`）。

---

#### 5.3.9 POST /api/games/:id/polish

AI 润色文本（不改变原意，用于发言/私聊前优化）。不改变游戏状态。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **请求体**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `text` | string | 是 | 待润色文本 |

- **返回** `200`：

```json
{ "polished": "润色后的流畅文本" }
```

- **错误**：`400` 缺 `text`

```bash
curl -X POST http://127.0.0.1:3000/api/games/01J9X...uuid/polish \
  -H "Content-Type: application/json" \
  -d '{ "text": "我 我昨天看到他了" }'
```

---

### 5.4 SSE 事件流

#### GET /api/games/:id/events

建立 SSE 长连接，接收该游戏的实时事件流（含连接建立时的当前快照重连）。

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **响应头**：`Content-Type: text/event-stream`，`Cache-Control: no-cache, no-transform`，`Connection: keep-alive`
- **机制**：
  - 连接建立后先推送一条 `snapshot` 事件（当前 `PublicSnapshot`），便于刷新/重连恢复界面。
  - 之后服务器按 `data: <JSON>\n\n` 格式推送 `GameEvent`。
  - `retry: 1000` 指示客户端断线 1s 后重连。
  - 私密事件（`whisper`/`investigate`）只推送给对应角色连接的客户端。

**事件类型（`GameEvent.type`）**：

| type | 说明 | 关键字段 |
| --- | --- | --- |
| `snapshot` | 连接初始快照（非 GameEvent，单独结构） | `snapshot: PublicSnapshot` |
| `narrator` | 主持人叙述 | `roleName:"主持人"`, `text` |
| `speak` | 公开发言 | `roleId`, `roleName`, `text` |
| `whisper` | 私聊（仅收发双方收到） | `roleId`, `target`, `text` |
| `investigate` | 调查结果（仅本人收到） | `roleId`, `target`, `text` |
| `show` | 出示线索（公开） | `roleId`, `target`(clueId), `text` |
| `vote` | 有人投票 | `roleId`, `roleName` |
| `phase` | 阶段变更 | `phase` |
| `turn` | 轮到某角色 | `roleId`, `roleName`, `humanTurn`, `round`, `currentTurn` |
| `system` | 系统提示 | `text` |
| `game_end` | 游戏结束 | `winner`(`"innocents"`\|`"culprit"`), `votes`, `truth` |

**`GameEvent` 字段**（详见 [6.4](#64-gameevent)）。

**连接示例（浏览器）**：

```js
const es = new EventSource(`/api/games/${gameId}/events`);
es.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === "snapshot") renderSnapshot(data.snapshot);
  else handleEvent(data); // GameEvent
};
es.onerror = () => { /* 浏览器会自动按 retry 重连 */ };
```

**连接示例（curl）**：

```bash
curl -N http://127.0.0.1:3000/api/games/01J9X...uuid/events
```

---

### 5.5 WebSocket 事件流（小程序）

WebSocket 端点为无法使用 SSE 的客户端（如微信小程序 `wx.connectSocket`）提供实时事件推送。**下行帧与 SSE 完全同构**，客户端按 `ev.type` 分发即可，事件类型表与 [5.4](#54-sse-事件流) 一致。SSE 与 WS 双传输并存，互不干扰。

#### WS /ws/games/:id

- **鉴权**：无
- **路径参数**：`id` — 游戏 ID
- **Query 参数**：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `roleId` | string | 是 | 人类玩家角色 ID，用于私密事件过滤（只推 public 事件 + 发给该角色的私密事件）。**缺省则服务端立即断开连接**。 |

- **协议**：标准 WebSocket（`ws://` / `wss://`），无自定义 subprotocol。
- **机制**：
  - 连接建立后**立即推送一条 `snapshot` 帧**（当前 `PublicSnapshot`），格式与 SSE 的 `data:` 行一致，便于重连/刷新恢复界面。
  - 之后按 `type` 推送 `GameEvent`，帧格式与 [5.4](#54-sse-事件流) 完全一致。
  - 私密事件（`whisper`/`investigate`）的 `scope` 过滤在 `broadcast` 内部完成：仅 `scope === "public"` 或 `scope === roleId` 的帧被发送。
  - **服务端不缓存 missed events**；断线期间的事件不补发。

**动作用于 HTTP（不走 WS）**

发言、私聊、调查、投票、润色等动作仍走 `POST /api/games/:id/action`、`/vote`、`/polish` 等 HTTP 路由（复用鉴权、校验、`session.lock` 串行化、快照持久化）。WebSocket **仅负责事件下行推送**。

**重连与恢复**

`wx.connectSocket` 无自动重连，客户端需自行实现：

1. 监听 `onClose` / `onError`，断线后循环 `connectSocket`（建议带退避）。
2. 重连成功后服务端会再次推送 `snapshot` 帧，客户端拿到后全量重建界面，无需服务端补发。

**连接示例（微信小程序）**：

```js
let ws;
function connect() {
  ws = wx.connectSocket({
    url: `ws://127.0.0.1:3000/ws/games/${gameId}?roleId=${roleId}`,
  });
  ws.onOpen(() => { /* 服务端会立即推送 snapshot 帧 */ });
  ws.onMessage((evt) => {
    const data = JSON.parse(evt.data);
    if (data.type === "snapshot") renderSnapshot(data.snapshot);
    else handleEvent(data);
  });
  ws.onClose(() => { /* 退避后重新 connect() */ });
}
connect();
```

**帧格式示例**：

```json
// 连接建立后首帧：全量快照
{ "type": "snapshot", "snapshot": { "id": "...", "phase": "discussion", "publicEvents": [], "myPrivateEvents": [], ... } }

// 公开发言
{ "id": "...", "at": 1723456789012, "type": "speak", "roleId": "r2", "roleName": "女主人", "text": "...", "scope": "public" }

// 本人私密调查
{ "id": "...", "at": 1723456789012, "type": "investigate", "roleId": "r1", "target": "l1", "text": "...", "scope": "r1" }

// 游戏结束
{ "id": "...", "at": 1723456789012, "type": "game_end", "winner": "innocents", "votes": {...}, "truth": {...}, "scope": "public" }
```

> **作用域说明**：WS 与 SSE 一样按 game 分桶（不按用户分桶）。过滤由 `WsHub.broadcast()` 根据 `humanRoleId` 完成。因此单局单人的现状下行为与 SSE 一致；若未来支持多人类玩家，需升级为按连接绑定 roleId 的分桶。

**事件类型**见 [5.4](#54-sse-事件流)，完全一致。

---

## 6. 数据模型

### 6.1 ScriptCard

```ts
interface ScriptCard {
  id: string;              // 剧本 ID
  title: string;           // 标题
  genre: string;           // 类型
  description: string;     // 简介
  playerCount: number;     // 玩家人数
  estimatedMinutes: number;// 预计时长（分钟）
  difficulty: string;      // 难度
}
```

### 6.2 ScriptSelectView

```ts
interface ScriptSelectView {
  id: string;
  title: string;
  genre: string;
  description: string;
  difficulty: string;
  playerCount: number;
  estimatedMinutes: number;
  setting: { time: string; place: string; background: string };
  roles: { id: string; name: string; public: string; goal: string }[];
  locations: { id: string; name: string; description: string }[];
  publicClues: { id: string; text: string }[];
}
```

### 6.3 PublicSnapshot

```ts
interface PublicSnapshot {
  id: string;               // 游戏 ID
  scriptId: string;
  phase: Phase;             // 见 3.4
  createdAt: number;        // 毫秒时间戳
  updatedAt: number;
  humanRoleId: string;      // 当前玩家角色 ID
  order: string[];          // 行动顺序（角色 ID 列表）
  turnIndex: number;        // 当前轮内序号
  round: number;            // 当前轮次
  maxRounds: number;        // 最大轮次（默认 4）
  currentTurn: string | null; // 当前回合角色 ID
  usedInvestigation: Record<string, boolean>; // 各角色本回合是否已调查
  roleClues: Record<string, string[]>;        // 仅含本人持有的线索 ID
  votes: Record<string, string | null>;       // 角色 ID -> 投票目标/null
  publicEvents: GameEvent[];                  // 公开事件流
  myPrivateEvents: GameEvent[];               // 本人私密事件
  winner?: "innocents" | "culprit";           // 结束后获胜阵营
}
```

### 6.4 GameEvent

```ts
type EventType =
  | "narrator" | "speak" | "whisper" | "investigate"
  | "show" | "vote" | "phase" | "turn" | "system" | "game_end";

interface GameEvent {
  id: string;
  at: number;              // 毫秒时间戳
  type: EventType;
  roleId?: string;
  roleName?: string;
  target?: string | null;  // whisper 目标 / show 的 clueId
  targetName?: string;
  text?: string;
  phase?: Phase;
  scope?: "public" | string; // 私密事件填收方角色 ID
  winner?: string;
  votes?: Record<string, string | null>;
  truth?: Truth;           // 仅 game_end 含完整真相
  round?: number;
  currentTurn?: string | null;
  humanTurn?: boolean;
}
```

> **Truth 结构**（揭晓时下发）：

```ts
interface Truth {
  culprit: string;         // 真凶角色 ID
  motive: string;          // 动机
  method: string;          // 手法
  timeline: { time: string; event: string }[];
}
```

---

## 7. 版本与变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| `v0.1.0` | 2026-08-12 | 初始版本。提供剧本库（列表/选角视图/生成）、游戏会话（建局/快照/我的角色/开始/恢复/行动/投票/润色）、SSE 事件流等接口。**无鉴权**。 |
| - | 2026-08-12 | 新增 WebSocket 端点 `/ws/games/:id?roleId=xxx`（5.5），下行帧与 SSE 同构，供小程序等非 SSE 客户端；SSE 与 WS 双传输并存。 |

### 7.1 兼容性说明

- 接口路径与请求/响应结构在 `v0.x` 阶段可能随玩法调整，**客户端应依赖 `gameId` 与 SSE 快照驱动 UI**，避免硬编码轮次/状态推导。
- 剧本 `schemaVersion` 字段随生成器升级递增；服务端 `validateScript` 仅做结构校验，不校验跨字段逻辑一致性。

### 7.2 后续规划（待办）

- `v0.2.0`：引入 `Authorization` 鉴权（见 [2. 鉴权方式](#2-鉴权方式)）。
- 统一错误响应包装（如 `{ code, message }`）与自定义业务错误码。
- 为生成接口补充进度 SSE（避免长时间无响应）。

---

> 文档由代码（`src/server/routes.ts`、`src/game/engine.ts`、`src/domain/*`、`src/game/types.ts`）逆向整理，与 `v0.1.0` 实现保持一致。如发现与代码不符，请以代码与 `README.md` 为准。
