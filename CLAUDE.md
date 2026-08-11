# CLAUDE.md — 剧本杀（script-kill）

剧本杀生成 + 单机游玩系统，`D:\1project\pi\apps\script-kill`。

- **独立项目**：有自己的 git 仓库（`apps/script-kill/.git`，分支 `main`），不引用外部 pi 项目路径。`src/paths.ts` 全部是项目内路径。
- **内核**：`@earendil-works/pi-agent-core`（Agent）+ `@earendil-works/pi-ai`（模型/provider）+ Fastify（后端 REST + SSE）。
- **生成**：`jubensha-gen` skill + 大模型产出符合 JSON Schema 的剧本，自动校验重试入库。
- **游玩**：人类玩家选一角色，其余角色各一个独立 Agent，主持人（DM）一个独立 Agent 掌控真相。

## 常用命令

```bash
npm run dev        # tsx watch 启动，默认 http://127.0.0.1:3000
npm run check      # tsc --noEmit 类型检查
npm run generate -- "题材" [玩家人数] [类型] [难度] [id]   # CLI 生成（默认带 story 优化）
npm start          # 单次启动（不 watch）
```

## 架构

```
config/models.json          模型配置（provider / 角色用模型）
.env                        API key（git 忽略，勿提交）；模板见 .env.example
src/
  index.ts                  入口：加载配置 → 构建模型注册表 → 启动服务
  paths.ts                  项目内路径（appRoot/data/.agents/config/public）
  config/env.ts             .env 加载器（幂等，OS 环境变量优先，不覆盖）
  config/models.ts          配置加载：interpolateKey 支持 字面量/$ENV_VAR/!command
  domain/schema.ts          剧本 JSON Schema（TypeBox）与纯结构校验
  domain/script-library.ts  剧本库存取 + 选角安全视图（过滤 secret/线索/真相）
  agents/factory.ts         Agent 工厂（封装 pi-agent-core 构造）
  agents/generation.ts      生成服务 + story-skill 优化（合并回填）
  game/{types,narrator,tools,engine,snapshots}.ts  游戏引擎/主持/工具/快照
  server/{index,routes,games,sse}.ts               Fastify 路由 + SSE
public/                     前端（index.html 剧本库 / room.html 房间）
scripts/generate-script.ts  CLI 生成
data/scripts/  data/games/  生成的剧本/会话快照（git 忽略）
.agents/skills/             skill：jubensha-gen + story-review/deslop/short-write/long-write
```

## 关键约定（踩过的坑，务必遵守）

1. **密钥只放 `.env`**：`config/models.json` 的 `apiKey` 只写 `$ENV_VAR`（如 `$ANT_LING_API_KEY`、`$OPENROUTER_API_KEY`）。**任何明文 API key 禁止写进配置文件、README 或 git。** 新增 provider 的 key 时：改 `config/models.json` 为 `$VAR`，把真实值加进 `.env`（git 忽略）和 `.env.example`（模板，留空）。
2. **默认主力模型是 ant-ling**（OpenAI 兼容，`Ling-3.0-flash`）。备用：`deepseek-gw`（DeepSeek Anthropic 网关）与 `openrouter`，改 `config/models.json` 的 `roles` 即可切换。
3. **`.env` 由 `src/config/env.ts` 的 `ensureEnvLoaded()` 加载**，在 `loadModelsConfigFile()` 顶部调用。OS 环境变量优先于 `.env`。`setx` 只对之后启动的进程生效，本会话的 bash 可能拿不到 —— 依赖 `.env` 即可。
4. **ant-ling 端点怪癖**：
   - 应用从不发送 `max_tokens`（config 的 `maxTokens` 不流通），别给它加 `max_tokens`。实测 `64` 会 500，`16384`/`65536` 正常。
   - pi-ai 流事件 `text_delta` 的字段是 `delta` / `partial`，**不是** `text`。
5. **`ScriptSchema` 是纯结构校验**：`validateScript` 不做跨字段检查（不校验 playerCount===roles.length、线索没点名真凶等）。逻辑一致性靠生成 prompt 约束，改 schema 时勿给 validateScript 加隐含业务规则。
6. **story 优化是「合并回填」**：`optimizeScript` 让模型只输出 4 类表达层字段（`description` / `setting.background` / `roles[].public` / `locations[].description`），应用端按 id 合并回原剧本 → 游戏事实（真凶/手法/时间线/秘密/线索/胜利条件）从构造上不可被改动。**不要**改回"模型输出整个剧本 + 指纹比对"方案（那样优化总是被拒）。
7. **CLI 生成带优化、HTTP 生成不带**：`scripts/generate-script.ts` 传 `{ optimize: true }`，`POST /api/scripts/generate` 不传（保持 ~16s 响应）。
8. **本环境限制**：
   - 不要用 `tsx -e`（stdout 不可靠），要用临时文件 + `npx tsx <file>`。
   - Node 的 `/tmp` 在 Windows 解析为 `D:\tmp`（可能不存在），临时文件放项目内（如 `data/`）。
   - bash 会吃掉 PowerShell 里的 `$_`；杀进程用 `tasklist`/`netstat` 或 `taskkill //F //PID`。
   - `tsx watch` 改文件重启可能 EADDRINUSE：先 `taskkill //F //PID <占端口进程>` 再重启。
9. **git 仓库在项目根**（`apps/script-kill/.git`），提交时在此目录执行；外部 pi 仓库的 `.gitignore` 有 `apps/*` 不会跟踪它。

## 开发流程（每次开发必做）

> **每次完成一个开发任务后，必须：**
> 1. 更新 `README.md`，使文档与代码现状一致（新功能、命令变化、配置变化、架构变化都要反映）。
> 2. 运行 `npm run check` 通过类型检查；涉及生成/游玩流程的改动做一次端到端验证。
> 3. 提交代码：`git add`（禁止 add 到 `.env`、`data/`、`node_modules/`）→ `git commit`，提交信息写清做了什么、为什么（中文/英文皆可，建议 feat/fix/chore 前缀）。
> 4. 涉及新配置/新模型/新 key 时同步更新 `.env.example` 模板。

## 游戏流程

`setup → reading → discussion（多轮，每人每轮 1 次调查）→ voting → reveal`

- 真相与所有地点/公共线索只进主持人 prompt；每个角色的私密信息只进该角色自己的 prompt。
- 主持人在揭晓前被硬性过滤（`leakCheck` 命中真凶名/手法词自动改写）。
- 投票严格多数（> 半数有效票）抓对真凶则好人胜；平票视为未抓住。
- 每步操作后快照持久化到 `data/games/`，服务重启可 `POST /api/games/:id/resume` 恢复。
