import type { MutableModels, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { EngineDeps, GameEvent, GameSession, PublicSnapshot } from "../game/types.js";
import { getScript, humanRoleView } from "../domain/script-library.js";
import { GameEngine } from "../game/engine.js";
import { createGameStore, listGames, loadGame, saveGame, type GameStore } from "../game/store.js";
import { sseHub } from "./sse.js";
import { wsHub } from "./ws.js";

export interface GameDeps {
	models: MutableModels;
	generatorModel: Model<any>;
	generatorThinking: ThinkingLevel;
	narratorModel: Model<any>;
	narratorThinking: ThinkingLevel;
	playerModel: Model<any>;
	playerThinking: ThinkingLevel;
}

/** 从 GameDeps 中取出引擎所需的 5 个模型字段，组装成 EngineDeps（修复 #10：消除重复样板）。 */
export function toEngineDeps(
	deps: GameDeps,
	onEvent: (e: GameEvent) => void,
	persist: () => void,
): EngineDeps {
	return {
		models: deps.models,
		narratorModel: deps.narratorModel,
		narratorThinking: deps.narratorThinking,
		playerModel: deps.playerModel,
		playerThinking: deps.playerThinking,
		onEvent,
		persist,
	};
}

/** 持久化实现：写入 SQLite 存储（fire-and-forget，错误只记录不抛出）。 */
function persistGame(gameId: string, store: GameStore, getSnapshot: () => GameSession["snapshot"]): void {
	void saveGame(store, getSnapshot()).catch((e) => {
		console.error(`[game:${gameId}] 持久化失败`, e);
	});
}

const sessions = new Map<string, GameSession>();

export async function createGame(
	scriptId: string,
	humanRoleId: string,
	deps: GameDeps,
): Promise<{ gameId: string; humanRole: ReturnType<typeof humanRoleView> }> {
	const script = getScript(scriptId);
	if (!script) throw new Error(`剧本 ${scriptId} 不存在`);
	if (!script.roles.some((r) => r.id === humanRoleId)) {
		throw new Error(`剧本中没有角色 ${humanRoleId}`);
	}
	const gameIdRef = { value: "" };
	const session = GameEngine.create(
		script,
		humanRoleId,
		toEngineDeps(
			deps,
			(e) => {
				if (e.scope === "public" || e.scope === humanRoleId) {
					sseHub.broadcast(gameIdRef.value, e);
					wsHub.broadcast(gameIdRef.value, e, humanRoleId);
				}
			},
			() => persistGame(gameIdRef.value, store, () => session.snapshot),
		),
	);
	const gameId = session.snapshot.id;
	gameIdRef.value = gameId;
	// 先建持久层 session 并写入初始快照，之后引擎的每次 touch 才可落盘。
	const store = await createGameStore(session.snapshot);
	sessions.set(gameId, session);
	return { gameId, humanRole: humanRoleView(script, humanRoleId) };
}

/** 取游戏会话：内存中有则复用，否则从 SQLite（回退旧 JSON）恢复。 */
export async function getSession(gameId: string, deps: GameDeps): Promise<GameSession> {
	const existing = sessions.get(gameId);
	if (existing) return existing;
	const loaded = await loadGame(gameId);
	if (!loaded) throw new Error(`游戏 ${gameId} 不存在`);
	const snap = loaded.snapshot;
	const script = getScript(snap.scriptId);
	if (!script) throw new Error(`剧本 ${snap.scriptId} 不存在`);
	const humanRoleId = snap.humanRoleId;
	const session = GameEngine.restore(
		snap,
		script,
		toEngineDeps(
			deps,
			(e) => {
				if (e.scope === "public" || e.scope === humanRoleId) {
					sseHub.broadcast(gameId, e);
					wsHub.broadcast(gameId, e, humanRoleId);
				}
			},
			() => persistGame(gameId, store, () => session.snapshot),
		),
	);
	// 旧版 JSON 恢复的游戏尚无 SQLite session：首次恢复即迁移。
	const store = loaded.store ?? (await createGameStore(snap));
	sessions.set(gameId, session);
	return session;
}

export async function listGamesView(): Promise<{ id: string; scriptId: string; phase: string; updatedAt: number }[]> {
	return listGames();
}

/** 构造仅供当前玩家查看的公开快照。 */
export function publicSnapshot(session: GameSession): PublicSnapshot {
	const snap = session.snapshot;
	const human = snap.humanRoleId;
	return {
		id: snap.id,
		scriptId: snap.scriptId,
		phase: snap.phase,
		createdAt: snap.createdAt,
		updatedAt: snap.updatedAt,
		humanRoleId: snap.humanRoleId,
		order: snap.order,
		turnIndex: snap.turnIndex,
		round: snap.round,
		maxRounds: snap.maxRounds,
		currentTurn: snap.currentTurn,
		usedInvestigation: snap.usedInvestigation,
		// 只暴露玩家自己的线索，避免看到他人持有的证据
		roleClues: { [human]: snap.roleClues[human] ?? [] },
		votes: snap.votes,
		publicEvents: snap.publicEvents,
		myPrivateEvents: snap.privateEvents[human] ?? [],
		winner: snap.winner,
	};
}
