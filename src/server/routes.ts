import type { FastifyInstance, FastifyReply } from "fastify";
import { createAgentFactory } from "../agents/factory.js";
import { generateScript } from "../agents/generation.js";
import { getScript, humanRoleView, listScripts, saveScript, scriptCard, scriptSelectView } from "../domain/script-library.js";
import { GameEngine } from "../game/engine.js";
import type { GameEvent } from "../game/types.js";
import { createGame, getSession, listGamesView, publicSnapshot, type GameDeps } from "./games.js";
import { sseHub } from "./sse.js";

interface RouteOpts {
	deps: GameDeps;
}

export async function routes(app: FastifyInstance, opts: RouteOpts): Promise<void> {
	const { deps } = opts;

	app.get("/api/health", async () => ({ ok: true }));

	// ---------- 剧本库 ----------

	app.get("/api/scripts", async () => listScripts().map(scriptCard));

	app.get("/api/scripts/:id", async (req, reply) => {
		const id = (req.params as { id: string }).id;
		const script = getScript(id);
		if (!script) return reply.code(404).send({ error: `剧本 ${id} 不存在` });
		return scriptSelectView(script);
	});

	app.post("/api/scripts/generate", async (req, reply) => {
		const body = (req.body ?? {}) as {
			topic?: string;
			playerCount?: number;
			genre?: string;
			difficulty?: string;
			id?: string;
		};
		if (!body.topic || !String(body.topic).trim()) {
			return reply.code(400).send({ error: "需要 topic（题材/背景）" });
		}
		try {
			const factory = createAgentFactory(deps.models);
			const script = await generateScript(
				{
					topic: String(body.topic).trim(),
					playerCount: Number(body.playerCount) || 5,
					genre: body.genre,
					difficulty: body.difficulty,
					id: body.id,
				},
				factory,
				{ model: deps.generatorModel, thinkingLevel: deps.generatorThinking },
			);
			saveScript(script);
			return { card: scriptCard(script), select: scriptSelectView(script) };
		} catch (e) {
			app.log.error(e);
			return reply.code(500).send({ error: (e as Error).message });
		}
	});

	// ---------- 游戏 ----------

	app.get("/api/games", async () => listGamesView());

	app.post("/api/games", async (req, reply) => {
		const body = (req.body ?? {}) as { scriptId?: string; humanRoleId?: string };
		if (!body.scriptId || !body.humanRoleId) {
			return reply.code(400).send({ error: "需要 scriptId 与 humanRoleId" });
		}
		try {
			const result = createGame(body.scriptId, body.humanRoleId, deps);
			return result;
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
	});

	app.get("/api/games/:id", async (req, reply) => {
		const id = (req.params as { id: string }).id;
		try {
			const session = getSession(id, deps);
			return publicSnapshot(session);
		} catch (e) {
			return reply.code(404).send({ error: (e as Error).message });
		}
	});

	app.get("/api/games/:id/me", async (req, reply) => {
		const id = (req.params as { id: string }).id;
		try {
			const session = getSession(id, deps);
			const script = session.script;
			const view = humanRoleView(script, session.snapshot.humanRoleId);
			if (!view) return reply.code(404).send({ error: "角色不存在" });
			return view;
		} catch (e) {
			return reply.code(404).send({ error: (e as Error).message });
		}
	});

	app.post("/api/games/:id/start", async (req, reply) => {
		try {
			const engine = new GameEngine(getSession((req.params as { id: string }).id, deps));
			await engine.start();
			return { ok: true };
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
	});

	app.post("/api/games/:id/resume", async (req, reply) => {
		try {
			const engine = new GameEngine(getSession((req.params as { id: string }).id, deps));
			await engine.resume();
			return { ok: true };
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
	});

	app.post("/api/games/:id/action", async (req, reply) => {
		const body = (req.body ?? {}) as { type?: string; content?: string; target?: string; clueId?: string };
		if (!body.type) return reply.code(400).send({ error: "需要 type" });
		try {
			const engine = new GameEngine(getSession((req.params as { id: string }).id, deps));
			await engine.humanAction({
				type: body.type,
				content: body.content,
				target: body.target,
				clueId: body.clueId,
			});
			return { ok: true };
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
	});

	app.post("/api/games/:id/vote", async (req, reply) => {
		const body = (req.body ?? {}) as { target?: string | null };
		try {
			const engine = new GameEngine(getSession((req.params as { id: string }).id, deps));
			await engine.humanVote(body.target === "" ? null : (body.target ?? null));
			return { ok: true };
		} catch (e) {
			return reply.code(400).send({ error: (e as Error).message });
		}
	});

	// ---------- SSE ----------

	app.get("/api/games/:id/events", async (req, reply) => {
		const id = (req.params as { id: string }).id;
		const session = getSession(id, deps);
		reply.hijack();
		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		});
		reply.raw.write("retry: 1000\n\n");
		// 连接建立后先推送一次当前公开快照，便于重连/刷新恢复界面
		reply.raw.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: publicSnapshot(session) })}\n\n`);
		sseHub.subscribe(id, reply);
	});
}
