import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	createNodeSqliteFactory,
	SqliteSessionRepository,
	type SqliteSessionMetadata,
} from "@earendil-works/pi-session-backend-sqlite-node";
import { gamesDir } from "../paths.js";
import type { GameSnapshot } from "./types.js";

/**
 * 游戏持久层：基于 @earendil-works/pi-session-backend-sqlite-node。
 * 一个游戏 = 一个 SQLite session；每次状态变化以 custom entry 追加完整快照
 * （append-only，最新一条即当前状态），避免自己实现文件读写与会话管理。
 *
 * 旧版本落盘的 data/games/*.json 仍可读取：SQLite 中不存在时回退读旧文件，
 * 恢复后首次持久化即迁移进 SQLite。
 */

/** 快照在 session 中的 custom entry 类型。 */
const SNAPSHOT_ENTRY_TYPE = "game_snapshot";

const repo = new SqliteSessionRepository({
	env: new NodeExecutionEnv({ cwd: gamesDir }),
	sqlite: createNodeSqliteFactory(),
	databasePath: join(gamesDir, "sessions.sqlite"),
});

/** 打开过的 session 句柄缓存，避免重复 claim writer lease。 */
const openStores = new Map<string, Session<SqliteSessionMetadata>>();

/** 游戏的持久句柄：pi session 负责落盘，业务只经此读写。 */
export interface GameStore {
	pi: Session<SqliteSessionMetadata>;
}

/** 创建新游戏的持久层 session 并写入初始快照。 */
export async function createGameStore(snapshot: GameSnapshot): Promise<GameStore> {
	const pi = await repo.create({
		id: snapshot.id,
		cwd: gamesDir,
		metadata: { scriptId: snapshot.scriptId, humanRoleId: snapshot.humanRoleId },
	});
	openStores.set(snapshot.id, pi);
	const store = { pi };
	await saveGame(store, snapshot);
	return store;
}

/** 追加保存一份完整快照（append-only；读取时取最新一条）。 */
export async function saveGame(store: GameStore, snapshot: GameSnapshot): Promise<void> {
	// pi 的 payload 校验拒绝 undefined 值，先做一次 JSON round-trip 归一化（顺带深拷贝，
	// 避免后续内存继续修改快照时影响已入队数据）。
	const normalized = JSON.parse(JSON.stringify(snapshot)) as GameSnapshot;
	await store.pi.appendCustomEntry(SNAPSHOT_ENTRY_TYPE, normalized);
}

export interface LoadedGame {
	store?: GameStore;
	snapshot: GameSnapshot;
}

/** 读取游戏：优先 SQLite，回退旧版 JSON 文件（store 为空，待恢复后迁移）。 */
export async function loadGame(id: string): Promise<LoadedGame | undefined> {
	const metadata = await findMetadata(id);
	if (metadata) {
		const pi = await openStore(id);
		const entry = await pi.findEntry({ customType: SNAPSHOT_ENTRY_TYPE, order: "newestFirst" });
		if (entry && entry.type === "custom") {
			return { store: { pi }, snapshot: entry.data as GameSnapshot };
		}
	}
	const legacy = readLegacySnapshot(id);
	return legacy ? { snapshot: legacy } : undefined;
}

/** 列出所有游戏（SQLite + 旧版 JSON 文件合并去重），按更新时间倒序。 */
export async function listGames(): Promise<{ id: string; scriptId: string; phase: string; updatedAt: number }[]> {
	const ids = new Set<string>((await repo.list()).map((m) => m.id));
	for (const file of legacyFiles()) ids.add(file.replace(/\.json$/, ""));

	const result: { id: string; scriptId: string; phase: string; updatedAt: number }[] = [];
	for (const id of ids) {
		const loaded = await loadGame(id);
		if (!loaded) continue;
		result.push({
			id,
			scriptId: loaded.snapshot.scriptId,
			phase: loaded.snapshot.phase,
			updatedAt: loaded.snapshot.updatedAt,
		});
	}
	return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 删除游戏：移除 SQLite session 与旧版 JSON 文件（若存在）。 */
export async function deleteGame(id: string): Promise<boolean> {
	const metadata = await findMetadata(id);
	if (metadata) await repo.delete(metadata);
	openStores.delete(id);
	const legacy = legacyFileOf(id);
	if (existsSync(legacy)) {
		try {
			unlinkSync(legacy);
		} catch {
			// 删除失败不阻断：SQLite 侧已删除，旧文件仅作兜底
		}
	}
	return metadata !== undefined || existsSync(legacy);
}

async function findMetadata(id: string): Promise<SqliteSessionMetadata | undefined> {
	return (await repo.list()).find((m) => m.id === id);
}

async function openStore(id: string): Promise<Session<SqliteSessionMetadata>> {
	const cached = openStores.get(id);
	if (cached) return cached;
	const metadata = await findMetadata(id);
	if (!metadata) throw new Error(`游戏 ${id} 不存在`);
	const pi = await repo.open(metadata);
	openStores.set(id, pi);
	return pi;
}

// ---------- 旧版 JSON 文件兼容 ----------

function legacyFileOf(id: string): string {
	return join(gamesDir, `${id}.json`);
}

function legacyFiles(): string[] {
	if (!existsSync(gamesDir)) return [];
	return readdirSync(gamesDir).filter((f) => f.endsWith(".json"));
}

function readLegacySnapshot(id: string): GameSnapshot | undefined {
	const file = legacyFileOf(id);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as GameSnapshot;
	} catch {
		return undefined;
	}
}
