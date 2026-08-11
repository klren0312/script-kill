import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { gamesDir } from "../paths.js";
import type { GameSnapshot } from "./types.js";

function fileOf(id: string): string {
	return join(gamesDir, `${id}.json`);
}

export function saveGame(snapshot: GameSnapshot): void {
	if (!existsSync(gamesDir)) mkdirSync(gamesDir, { recursive: true });
	writeFileSync(fileOf(snapshot.id), JSON.stringify(snapshot, null, 2), "utf8");
}

export function loadGame(id: string): GameSnapshot | undefined {
	const file = fileOf(id);
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as GameSnapshot;
	} catch {
		return undefined;
	}
}

export function listGames(): { id: string; scriptId: string; phase: string; updatedAt: number }[] {
	if (!existsSync(gamesDir)) return [];
	return readdirSync(gamesDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			try {
				const snap = JSON.parse(readFileSync(join(gamesDir, f), "utf8")) as GameSnapshot;
				return {
					id: snap.id,
					scriptId: snap.scriptId,
					phase: snap.phase as string,
					updatedAt: snap.updatedAt,
				};
			} catch {
				return undefined;
			}
		})
		.filter((x): x is { id: string; scriptId: string; phase: string; updatedAt: number } => x !== undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteGame(id: string): boolean {
	const file = fileOf(id);
	if (!existsSync(file)) return false;
	try {
		unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}
