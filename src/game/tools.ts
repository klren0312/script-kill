import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { GameEvent, Phase } from "./types.js";

export interface ToolHost {
	readonly roleId: string;
	readonly roleName: string;
	phase(): Phase;
	validTargets(): string[];
	locationIds(): string[];
	snapshotAccess(): {
		usedInvestigation: Record<string, boolean>;
		roleClues: Record<string, string[]>;
	};
	/** 仅查询本回合是否已调查过（不修改额度）。额度扣减统一由 engine.performInvestigate 负责。 */
	hasInvestigated(): boolean;
	recordPublic(event: Omit<GameEvent, "id" | "at">): void;
	recordPrivate(toRoleId: string, event: Omit<GameEvent, "id" | "at">): void;
	resolveInvestigation(target: string): Promise<string>;
	recordVote(target: string | null): void;
	clueText(clueId: string): string | undefined;
	roleNameOf(roleId: string): string;
}

function ok(textContent: string) {
	return {
		content: [{ type: "text" as const, text: textContent }],
		details: {},
	};
}

export function createRoleTools(host: ToolHost): AgentTool[] {
	return [
		{
			name: "speak",
			label: "公开发言",
			description: "在房间内对所有人公开发言。content 为发言内容，可以是论述、质疑、辩解或出示线索时的说辞。",
			parameters: Type.Object({
				content: Type.String({ description: "发言内容" }),
			}),
			execute: async (_id, params) => {
				const { content } = params as { content: string };
				host.recordPublic({
					type: "speak",
					roleId: host.roleId,
					roleName: host.roleName,
					text: content,
				});
				return ok("你已公开发言。");
			},
		},
		{
			name: "whisper",
			label: "私聊",
			description: "私下只向某个角色发送信息，其他玩家看不到。target 为目标角色 id，content 为内容。",
			parameters: Type.Object({
				target: Type.String({ description: "目标角色 id" }),
				content: Type.String({ description: "私聊内容" }),
			}),
			execute: async (_id, params) => {
				const { target, content } = params as { target: string; content: string };
				if (!host.validTargets().includes(target)) {
					return ok(`目标 "${target}" 不是有效角色。`);
				}
				host.recordPrivate(target, {
					type: "whisper",
					roleId: host.roleId,
					roleName: host.roleName,
					target,
					targetName: host.roleNameOf(target),
					text: content,
				});
				host.recordPrivate(host.roleId, {
					type: "system",
					roleId: host.roleId,
					roleName: host.roleName,
					text: `你向 ${host.roleNameOf(target)} 私语了一句话。`,
				});
				return ok("你已发出私聊。");
			},
		},
		{
			name: "investigate",
			label: "调查",
			description: "调查一个地点（location id）或一个角色（角色 id），获取相关信息。每回合限用一次。",
			parameters: Type.Object({
				target: Type.String({ description: "调查目标 id（地点或角色）" }),
			}),
			execute: async (_id, params) => {
				const { target } = params as { target: string };
				if (!host.validTargets().includes(target) && !host.locationIds().includes(target)) {
					return ok(`目标 "${target}" 不存在。`);
				}
				if (host.hasInvestigated()) {
					return ok("你本回合已经调查过了，不能再调查。");
				}
				const result = await host.resolveInvestigation(target);
				return ok(result);
			},
		},
		{
			name: "show",
			label: "出示线索",
			description: "当众出示一条你持有的线索。clueId 为线索 id。",
			parameters: Type.Object({
				clueId: Type.String({ description: "线索 id" }),
			}),
			execute: async (_id, params) => {
				const { clueId } = params as { clueId: string };
				const owned = host.snapshotAccess().roleClues[host.roleId] ?? [];
				if (!owned.includes(clueId)) return ok(`你并不持有线索 ${clueId}。`);
				const clueText = host.clueText(clueId);
				host.recordPublic({
					type: "show",
					roleId: host.roleId,
					roleName: host.roleName,
					target: clueId,
					text: clueText,
				});
				return ok(`你出示了线索 ${clueId}。`);
			},
		},
		{
			name: "vote",
			label: "投票",
			description: "在投票阶段投出你认为的真凶。target 为角色 id；弃权填 null。",
			parameters: Type.Object({
				target: Type.Union([Type.String(), Type.Null()]),
			}),
			execute: async (_id, params) => {
				const { target } = params as { target: string | null };
				if (host.phase() !== "voting") return ok("现在不是投票阶段。");
				if (target && !host.validTargets().includes(target)) {
					return ok(`目标 "${target}" 不是有效角色。`);
				}
				host.recordVote(target);
				return ok(target ? `你投票给了 ${host.roleNameOf(target)}。` : "你选择了弃权。");
			},
		},
	];
}
