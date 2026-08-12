import type { GameEvent } from "../game/types.js";

/** 通用 WS socket 接口，解耦具体实现（ws/uws），避免引入 @types/ws。 */
interface WSSocket {
	send: (data: string) => void | boolean;
	on: (event: string, cb: () => void) => void;
	end?: () => void;
	readyState?: number;
}

/** 简易 WebSocket 客户端管理：按 gameId 分桶广播事件，过滤在 broadcast 内部完成。 */
export class WsHub {
	private clients = new Map<string, Set<WSSocket>>();

	subscribe(gameId: string, socket: WSSocket): void {
		let set = this.clients.get(gameId);
		if (!set) {
			set = new Set();
			this.clients.set(gameId, set);
		}
		set.add(socket);
		socket.on("close", () => this.unsubscribe(gameId, socket));
	}

	unsubscribe(gameId: string, socket: WSSocket): void {
		const set = this.clients.get(gameId);
		if (!set) return;
		set.delete(socket);
		if (set.size === 0) this.clients.delete(gameId);
	}

	/**
	 * 向 gameId 的所有 WS 客户端广播事件。
	 * scope 过滤在此完成：仅 public 事件或发给指定 humanRoleId 的私密事件才会被推送。
	 * 注意：与 SSE 不同，WS 是按 game 分桶、不按用户分桶，因此过滤必须在调用侧。
	 */
	broadcast(gameId: string, event: GameEvent, humanRoleId?: string): void {
		const set = this.clients.get(gameId);
		if (!set || set.size === 0) return;
		if (!isBroadcastableScope(event.scope, humanRoleId)) return;
		const data = JSON.stringify(event);
		for (const socket of set) {
			try {
				if (socket.readyState === 3 || socket.readyState === 4) {
					// CLOSING / CLOSED，移除死连接
					set.delete(socket);
					continue;
				}
				socket.send(data);
			} catch (_e) {
				// 发送失败（连接已断），移除
				set.delete(socket);
			}
		}
		if (set.size === 0) this.clients.delete(gameId);
	}

	clientsCount(gameId: string): number {
		return this.clients.get(gameId)?.size ?? 0;
	}
}

function isBroadcastableScope(scope: GameEvent["scope"], humanRoleId?: string): boolean {
	if (scope === "public") return true;
	return scope === humanRoleId;
}

export const wsHub = new WsHub();