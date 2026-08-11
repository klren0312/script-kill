import type { MutableModels, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getScript, humanRoleView } from "../domain/script-library.js";
import { GameEngine } from "../game/engine.js";
import { listGames, loadGame, saveGame } from "../game/snapshots.js";
import type { GameSession, PublicSnapshot } from "../game/types.js";
import { sseHub } from "./sse.js";

export interface GameDeps {
	models: MutableModels;
	generatorModel: Model<any>;
	generatorThinking: ThinkingLevel;
	narratorModel: Model<any>;
	narratorThinking: ThinkingLevel;
	playerModel: Model<any>;
	playerThinking: ThinkingLevel;
}

const sessions = new Map<string, GameSession>();

export function createGame(
	scriptId: string,
	humanRoleId: string,
	deps: GameDeps,
): { gameId: string; humanRole: ReturnType<typeof humanRoleView> } {
	const script = getScript(scriptId);
	if (!script) throw new Error(`剧本 ${scriptId} 不存在`);
	if (!script.roles.some((r) => r.id === humanRoleId)) {
		throw new Error(`剧本中没有角色 ${humanRoleId}`);
	}
	const session = GameEngine.create(script, humanRoleId, {
		models: deps.models,
		narratorModel: deps.narratorModel,
		narratorThinking: deps.narratorThinking,
		playerModel: deps.playerModel,
		playerThinking: deps.playerThinking,
		onEvent: () => {},
		persist: () => {},
	});
	const gameId = session.snapshot.id;
	sessions.set(gameId, session);
	// create 阶段不产生事件，因此此后绑定广播是安全的
	session.deps.onEvent = (e) => {
		if (e.scope === "public" || e.scope === session.snapshot.humanRoleId) {
			sseHub.broadcast(gameId, e);
		}
	};
	session.deps.persist = () => saveGame(session.snapshot);
	session.deps.persist();
	return { gameId, humanRole: humanRoleView(script, humanRoleId) };
}

/** 取游戏会话：内存中有则复用，否则从磁盘快照恢复。 */
export function getSession(gameId: string, deps: GameDeps): GameSession {
	const existing = sessions.get(gameId);
	if (existing) return existing;
	const snap = loadGame(gameId);
	if (!snap) throw new Error(`游戏 ${gameId} 不存在`);
	const script = getScript(snap.scriptId);
	if (!script) throw new Error(`剧本 ${snap.scriptId} 不存在`);
	const session = GameEngine.restore(snap, script, {
		models: deps.models,
		narratorModel: deps.narratorModel,
		narratorThinking: deps.narratorThinking,
		playerModel: deps.playerModel,
		playerThinking: deps.playerThinking,
		onEvent: (e) => {
			if (e.scope === "public" || e.scope === session.snapshot.humanRoleId) {
				sseHub.broadcast(gameId, e);
			}
		},
		persist: () => saveGame(session.snapshot),
	});
	sessions.set(gameId, session);
	return session;
}

export function listGamesView(): { id: string; scriptId: string; phase: string; updatedAt: number }[] {
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
		privateEvents: snap.privateEvents[human] ?? [],
		winner: snap.winner,
	};
}
