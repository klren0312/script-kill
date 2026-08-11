import type { GameEvent } from "../game/types.js";

type Reply = {
	raw: {
		write: (chunk: string) => void;
		writeHead: (status: number, headers: Record<string, string>) => void;
		end: () => void;
	};
	request: { raw: { on: (event: string, cb: () => void) => void } };
};

/** 简易 SSE 客户端管理：按 gameId 分桶广播事件。过滤在调用侧（onEvent）完成。 */
export class SseHub {
	private clients = new Map<string, Set<Reply>>();

	subscribe(gameId: string, reply: Reply): void {
		let set = this.clients.get(gameId);
		if (!set) {
			set = new Set();
			this.clients.set(gameId, set);
		}
		set.add(reply);
		reply.request.raw.on("close", () => this.unsubscribe(gameId, reply));
	}

	unsubscribe(gameId: string, reply: Reply): void {
		const set = this.clients.get(gameId);
		if (!set) return;
		set.delete(reply);
		if (set.size === 0) this.clients.delete(gameId);
	}

	broadcast(gameId: string, event: GameEvent): void {
		const set = this.clients.get(gameId);
		if (!set || set.size === 0) return;
		const data = `data: ${JSON.stringify(event)}\n\n`;
		for (const reply of set) reply.raw.write(data);
	}

	clientsCount(gameId: string): number {
		return this.clients.get(gameId)?.size ?? 0;
	}
}

export const sseHub = new SseHub();
