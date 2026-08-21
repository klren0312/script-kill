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
	private heartbeats = new Map<string, NodeJS.Timeout>();

	private startHeartbeat(gameId: string): void {
		const interval = setInterval(() => {
			const set = this.clients.get(gameId);
			if (!set || set.size === 0) {
				this.stopHeartbeat(gameId);
				return;
			}
			const heartbeat = `: heartbeat\n\n`;
			for (const reply of set) {
				try {
					reply.raw.write(heartbeat);
				} catch (_e) {
					// 静默忽略写失败，由 broadcast 错误处理统一处理
				}
			}
		}, 30_000); // 30 秒
		this.heartbeats.set(gameId, interval);
	}

	private stopHeartbeat(gameId: string): void {
		const interval = this.heartbeats.get(gameId);
		if (interval) {
			clearInterval(interval);
			this.heartbeats.delete(gameId);
		}
	}

	subscribe(gameId: string, reply: Reply): void {
		let set = this.clients.get(gameId);
		if (!set) {
			set = new Set();
			this.clients.set(gameId, set);
		}
		set.add(reply);
		reply.request.raw.on("close", () => this.unsubscribe(gameId, reply));

		// 如果这是该房间的第一个客户端，启动心跳
		if (!this.heartbeats.has(gameId)) {
			this.startHeartbeat(gameId);
		}
	}

	unsubscribe(gameId: string, reply: Reply): void {
		const set = this.clients.get(gameId);
		if (!set) return;
		set.delete(reply);
		if (set.size === 0) {
			this.clients.delete(gameId);
			this.stopHeartbeat(gameId);
		}
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
