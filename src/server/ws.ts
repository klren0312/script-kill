import type { GameEvent } from "../game/types.js";

/** 通用 WS socket 接口，解耦具体实现（ws/uws），避免引入 @types/ws。 */
interface WSSocket {
	send: (data: string) => void | boolean;
	on: (event: string, cb: () => void) => void;
	end?: () => void;
	close?: () => void;
	readyState?: number;
}

/** 按客户端的订阅记录：socket 与其声称的角色身份（用于私密事件过滤）。 */
interface Subscriber {
	socket: WSSocket;
	roleId?: string;
}

/** ws 库就绪状态常量（仅 0/1/2/3，无 4）。 */
const WS_CLOSED = 3;

/** 简易 WebSocket 客户端管理：按 gameId 分桶广播事件，过滤在 broadcast 内部完成。 */
export class WsHub {
	private clients = new Map<string, Set<Subscriber>>();

	subscribe(gameId: string, socket: WSSocket, roleId?: string): void {
		let set = this.clients.get(gameId);
		if (!set) {
			set = new Set();
			this.clients.set(gameId, set);
		}
		set.add({ socket, roleId });
		socket.on("close", () => this.unsubscribe(gameId, socket));
	}

	unsubscribe(gameId: string, socket: WSSocket): void {
		const set = this.clients.get(gameId);
		if (!set) return;
		for (const sub of set) {
			if (sub.socket === socket) {
				set.delete(sub);
				break;
			}
		}
		if (set.size === 0) this.clients.delete(gameId);
	}

	/**
	 * 向 gameId 的所有 WS 客户端广播事件。
	 * scope 过滤在此完成：public 事件推送给所有人；私密事件仅推送给对应身份的客户端。
	 * 注意：与 SSE 不同，WS 是按 game 分桶、不按用户分桶，因此过滤需基于每个客户端订阅时的 roleId。
	 */
	broadcast(gameId: string, event: GameEvent, _humanRoleId?: string): void {
		const set = this.clients.get(gameId);
		if (!set || set.size === 0) return;
		const data = JSON.stringify(event);
		for (const sub of set) {
			try {
				if (sub.socket.readyState === WS_CLOSED) {
					set.delete(sub);
					continue;
				}
				if (!isBroadcastableScope(event.scope, sub.roleId)) continue;
				sub.socket.send(data);
			} catch (_e) {
				set.delete(sub);
			}
		}
		if (set.size === 0) this.clients.delete(gameId);
	}

	clientsCount(gameId: string): number {
		return this.clients.get(gameId)?.size ?? 0;
	}
}

function isBroadcastableScope(scope: GameEvent["scope"], roleId?: string): boolean {
	if (scope === "public") return true;
	return scope === roleId;
}

export const wsHub = new WsHub();