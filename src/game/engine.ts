import { uuidv7 } from "@earendil-works/pi-agent-core";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { Role, Script } from "../domain/schema.js";
import { resolveClueText } from "../domain/script-library.js";
import { createAgentFactory, lastAssistantText } from "../agents/factory.js";
import { buildLeakInfo, buildNarratorPrompt, leakCheck, maskLeaks, type LeakInfo } from "./narrator.js";
import { createRoleTools, type ToolHost } from "./tools.js";
import type { EngineDeps, GameEvent, GameSession, Phase } from "./types.js";

const DEFAULT_MAX_ROUNDS = 4;

export function buildRolePrompt(script: Script, role: Role): string {
	return `你是剧本杀《${script.title}》中的角色「${role.name}」。你要在这场推理游戏中扮演好这个角色，设法达成自己的目标，同时不让别人轻易识破你的底牌。

【角色公开信息】（所有玩家都知道）
${role.public}

【只有你知道的私密信息】
${role.secret}

【你的目标】
${role.goal}

【游戏规则】
- 场景：${script.setting.time} / ${script.setting.place}；背景：${script.setting.background}
- 你持有的线索：${role.clues.join(", ") || "无"}
- 你可以使用工具行动：speak 公开发言、whisper 私聊、investigate 调查（每回合限 1 次）、show 出示线索、vote 投票。
- 说话要符合人设；在符合你私密设定的前提下，你可以撒谎、隐瞒、诱导，但不要提及"我是AI""工具调用"等。
- 你的私密信息是别人不知道的，不要主动泄露，除非策略需要。
- 轮到你时，用 speak 公开发言，或先行动再发言。`;
}

export class GameEngine {
	private session: GameSession;
	private leakInfo: LeakInfo;
	private turnSpoke = false;

	/**
	 * 当前回合者。存到 session（而非实例）上，这样每次请求新建的
	 * GameEngine 包装都共享同一状态，且随快照持久化。
	 */
	private get currentTurn(): string | null {
		return this.session.currentTurn;
	}
	private set currentTurn(v: string | null) {
		this.session.currentTurn = v;
		this.session.snapshot.currentTurn = v;
	}

	constructor(session: GameSession) {
		this.session = session;
		this.leakInfo = buildLeakInfo(session.script);
	}

	/** 串行化引擎操作，避免 AI 回合与人类操作交错。 */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const s = this.session;
		const run = s.lock.then(fn, fn);
		s.lock = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	// ---------- 创建 / 恢复 ----------

	static create(script: Script, humanRoleId: string, deps: EngineDeps): GameSession {
		const now = Date.now();
		const publicClueIds = script.publicClues.map((c) => c.id);
		const snapshot = {
			id: uuidv7(),
			scriptId: script.id,
			phase: "setup",
			createdAt: now,
			updatedAt: now,
			humanRoleId,
			order: script.roles.map((r) => r.id),
			turnIndex: 0,
			round: 0,
			maxRounds: DEFAULT_MAX_ROUNDS,
			currentTurn: null,
			usedInvestigation: {},
			usedLocationClues: {},
			roleClues: {},
			votes: {},
			publicEvents: [],
			privateEvents: {},
			narratorTranscript: [],
			roleTranscripts: {},
			winner: undefined,
		} as GameSession["snapshot"];

		const factory = createAgentFactory(deps.models);
		const session = {
			snapshot,
			script,
			narrator: null as unknown as Agent,
			roles: {},
			currentTurn: null,
			deps,
			lock: Promise.resolve(),
		} as GameSession;
		session.narrator = factory.create({
			systemPrompt: buildNarratorPrompt(script),
			model: deps.narratorModel,
			thinkingLevel: deps.narratorThinking,
		});
		const engine = new GameEngine(session);
		for (const r of script.roles) {
			snapshot.roleClues[r.id] = [...r.clues, ...publicClueIds];
			if (r.id === humanRoleId) continue;
			session.roles[r.id] = factory.create({
				systemPrompt: buildRolePrompt(script, r),
				model: deps.playerModel,
				thinkingLevel: deps.playerThinking,
				tools: createRoleTools(engine.makeToolHost(r)),
			});
		}
		snapshot.phase = "reading";
		return session;
	}

	static restore(
		snapshot: GameSession["snapshot"],
		script: Script,
		deps: EngineDeps,
	): GameSession {
		const factory = createAgentFactory(deps.models);
		const session = {
			snapshot,
			script,
			narrator: null as unknown as Agent,
			roles: {},
			currentTurn: snapshot.currentTurn,
			deps,
			lock: Promise.resolve(),
		} as GameSession;
		session.narrator = factory.create({
			systemPrompt: buildNarratorPrompt(script),
			model: deps.narratorModel,
			thinkingLevel: deps.narratorThinking,
			messages: snapshot.narratorTranscript,
		});
		const engine = new GameEngine(session);
		for (const r of script.roles) {
			if (r.id === snapshot.humanRoleId) continue;
			session.roles[r.id] = factory.create({
				systemPrompt: buildRolePrompt(script, r),
				model: deps.playerModel,
				thinkingLevel: deps.playerThinking,
				tools: createRoleTools(engine.makeToolHost(r)),
				messages: snapshot.roleTranscripts[r.id],
			});
		}
		return session;
	}

	// ---------- 事件 / 状态 ----------

	private emitPublic(partial: Omit<GameEvent, "id" | "at">): GameEvent {
		const event: GameEvent = { ...partial, id: uuidv7(), at: Date.now(), scope: "public" };
		this.session.snapshot.publicEvents.push(event);
		this.session.deps.onEvent(event);
		return event;
	}

	private emitPrivate(toRoleId: string, partial: Omit<GameEvent, "id" | "at">): GameEvent {
		const event: GameEvent = { ...partial, id: uuidv7(), at: Date.now(), scope: toRoleId };
		const bucket = (this.session.snapshot.privateEvents[toRoleId] ??= []);
		bucket.push(event);
		this.session.deps.onEvent(event);
		return event;
	}

	private touch(): void {
		this.session.snapshot.updatedAt = Date.now();
		this.session.deps.persist();
	}

	private setPhase(phase: Phase): void {
		this.session.snapshot.phase = phase;
		this.emitPublic({ type: "phase", phase });
		this.touch();
	}

	private role(roleId: string): Role {
		const r = this.session.script.roles.find((x) => x.id === roleId);
		if (!r) throw new Error(`角色 ${roleId} 不存在`);
		return r;
	}

	private isRole(id: string): boolean {
		return this.session.script.roles.some((r) => r.id === id);
	}

	private clueText(clueId: string): string | undefined {
		return resolveClueText(this.session.script, clueId);
	}

	private async narratorPrompt(text: string): Promise<string> {
		await this.session.narrator.prompt(text);
		return lastAssistantText(this.session.narrator);
	}

	/** 使用主持人的模型对一段文本进行润色（不改变游戏状态）。 */
	async polishText(text: string): Promise<string> {
		const result = await this.narratorPrompt(
			`你是一位文本润色助手。请润色以下文本，保持原意不变，使表达更流畅、更自然（适合剧本杀主持人口吻）。只返回润色后的文本，不要加任何解释或说明。\n\n${text}`,
		);
		return result || text;
	}

	private nextLocationClue(locationId: string): string | undefined {
		const s = this.session;
		const loc = s.script.locations.find((l) => l.id === locationId);
		if (!loc) return undefined;
		const idx = s.snapshot.usedLocationClues[locationId] ?? 0;
		s.snapshot.usedLocationClues[locationId] = idx + 1;
		return idx < loc.clues.length ? loc.clues[idx].text : undefined;
	}

	// ---------- 调查 ----------

	async resolveInvestigation(roleId: string, target: string): Promise<string> {
		const s = this.session;
		const investigator = this.role(roleId);
		const location = s.script.locations.find((l) => l.id === target);
		let result: string;
		if (location) {
			const clueText = this.nextLocationClue(location.id) ?? "这里没有更多新发现了。";
			result = await this.narratorPrompt(
				`角色「${investigator.name}」正在调查地点「${location.name}」（${location.id}）。剧本设定该地点的线索是：${clueText}\n请以主持人身份描述这次调查的过程与发现，围绕该线索展开场景化叙述，但不要提"剧本设定""线索"等字眼，也不要编造其他关键证据。`,
			);
		} else if (this.isRole(target)) {
			result = await this.narratorPrompt(
				`角色「${investigator.name}」正在调查玩家「${this.role(target).name}」（${target}）。请结合你掌握的真相，描述调查该角色能得到的发现（言行举止、物证、疑点），但绝不能泄露真凶身份或关键作案手法。`,
			);
		} else {
			throw new Error(`目标 "${target}" 不存在`);
		}
		const leak = leakCheck(result, this.leakInfo);
		if (leak) {
			result = await this.narratorPrompt(
				`你刚才的描述泄露了信息（包含"${leak}"）。请改写为中性描述，不得直接说出真凶身份或作案手法细节。`,
			);
			result = maskLeaks(result, this.leakInfo);
		}
		this.emitPrivate(roleId, {
			type: "investigate",
			roleId,
			roleName: investigator.name,
			target,
			targetName: location?.name ?? this.role(target).name,
			text: result,
		});
		return result;
	}

	// ---------- 人类行动 ----------

	async humanAction(body: {
		type: string;
		content?: string;
		target?: string;
		clueId?: string;
	}): Promise<void> {
		await this.exclusive(async () => {
			const s = this.session;
			const roleId = s.snapshot.humanRoleId;
			if (!roleId) throw new Error("尚未加入游戏");
			switch (body.type) {
				case "speak":
					this.requireTurn(roleId);
					this.performSpeak(roleId, body.content ?? "");
					break;
				case "whisper":
					this.requireTurn(roleId);
					this.performWhisper(roleId, body.target ?? "", body.content ?? "");
					break;
				case "investigate": {
					this.requireTurn(roleId);
					await this.performInvestigate(roleId, body.target ?? "");
					break;
				}
				case "show":
					this.requireTurn(roleId);
					this.performShow(roleId, body.clueId ?? "");
					break;
				case "endTurn":
					this.requireTurn(roleId);
					this.currentTurn = null;
					this.touch();
					await this.advance();
					break;
				default:
					throw new Error(`未知行动 ${body.type}`);
			}
		});
	}

	private requireTurn(roleId: string): void {
		if (this.currentTurn !== roleId) {
			throw new Error("现在不是你的回合");
		}
	}

	private performSpeak(roleId: string, content: string): void {
		this.turnSpoke = true;
		this.emitPublic({ type: "speak", roleId, roleName: this.role(roleId).name, text: content });
		this.touch();
	}

	private performWhisper(fromId: string, target: string, content: string): void {
		if (!this.isRole(target)) throw new Error(`目标 "${target}" 不是有效角色`);
		this.emitPrivate(target, {
			type: "whisper",
			roleId: fromId,
			roleName: this.role(fromId).name,
			target,
			targetName: this.role(target).name,
			text: content,
		});
		this.emitPrivate(fromId, {
			type: "system",
			roleId: fromId,
			roleName: this.role(fromId).name,
			text: `你向 ${this.role(target).name} 私语了一句话。`,
		});
		this.touch();
	}

	private async performInvestigate(roleId: string, target: string): Promise<string> {
		if (this.session.snapshot.usedInvestigation[roleId]) {
			throw new Error("本回合已调查过");
		}
		this.session.snapshot.usedInvestigation[roleId] = true;
		const result = await this.resolveInvestigation(roleId, target);
		this.touch();
		return result;
	}

	private performShow(roleId: string, clueId: string): void {
		const owned = this.session.snapshot.roleClues[roleId] ?? [];
		if (!owned.includes(clueId)) throw new Error(`未持有线索 ${clueId}`);
		const text = this.clueText(clueId);
		this.emitPublic({ type: "show", roleId, roleName: this.role(roleId).name, target: clueId, text });
		this.touch();
	}

	async humanVote(target: string | null): Promise<void> {
		await this.exclusive(async () => {
			const s = this.session;
			if (s.snapshot.phase !== "voting") throw new Error("现在不是投票阶段");
			const human = s.snapshot.humanRoleId;
			if (!human) throw new Error("尚未加入游戏");
			if (target && !this.isRole(target)) throw new Error(`目标 "${target}" 不是有效角色`);
			if (s.snapshot.votes[human] !== undefined) throw new Error("你已经投过票了");
			s.snapshot.votes[human] = target;
			this.emitPublic({
				type: "vote",
				roleId: human,
				roleName: this.role(human).name,
				text: "已投票",
			});
			this.touch();
			await this.maybeFinishVoting();
		});
	}

	// ---------- 游戏流程 ----------

	async start(): Promise<void> {
		await this.exclusive(async () => {
			const s = this.session;
			if (s.snapshot.phase !== "reading") throw new Error("游戏不在待开始状态");
			s.snapshot.round = 1;
			s.snapshot.turnIndex = 0;
			this.setPhase("discussion");
			const opening = await this.narratorPrompt(
				`游戏开始。请以主持人口吻介绍案发背景与开场情境，宣布调查讨论开始。（不得泄露真相）`,
			);
			this.emitPublic({ type: "narrator", roleName: "主持人", text: opening });
			this.currentTurn = s.snapshot.order[0];
			this.touch();
			await this.beginTurn();
		});
	}

	/** 恢复时若停留在某 AI 回合，则重跑该回合。 */
	async resume(): Promise<void> {
		await this.exclusive(async () => {
			const s = this.session;
			if (s.snapshot.phase !== "discussion") return;
			const t = s.snapshot.currentTurn;
			this.currentTurn = t;
			if (t && t !== s.snapshot.humanRoleId) {
				await this.beginTurn();
			} else if (t === null) {
				await this.advance();
			}
		});
	}

	private async beginTurn(): Promise<void> {
		const s = this.session;
		if (this.currentTurn === null) return;
		const roleId = this.currentTurn;
		const role = this.role(roleId);
		const human = roleId === s.snapshot.humanRoleId;
		this.turnSpoke = false;
		this.emitPublic({
			type: "turn",
			roleId,
			roleName: role.name,
			humanTurn: human,
			round: s.snapshot.round,
			currentTurn: roleId,
		});
		this.touch();
		if (human) return; // 等待玩家行动 / 结束回合
		await this.runAiTurn(roleId);
	}

	private async runAiTurn(roleId: string): Promise<void> {
		const s = this.session;
		const agent = s.roles[roleId];
		const role = this.role(roleId);
		try {
			await agent.prompt(
				`这是第 ${s.snapshot.round} 轮讨论。轮到你（${role.name}）行动。你可以：用 speak 公开发言；用 whisper 与某人私聊；用 investigate 调查（每人每回合限 1 次）；用 show 出示线索。请发言或行动。`,
			);
			const text = lastAssistantText(agent);
			if (!this.turnSpoke && text.trim()) {
				this.performSpeak(roleId, text);
			}
		} catch (e) {
			this.emitPublic({ type: "system", text: `角色 ${role.name} 行动出错: ${(e as Error).message}` });
		}
		this.currentTurn = null;
		this.touch();
		await this.advance();
	}

	private async advance(): Promise<void> {
		const s = this.session;
		if (this.currentTurn !== null || s.snapshot.phase !== "discussion") return;
		const order = s.snapshot.order;
		const next = s.snapshot.turnIndex + 1;
		if (next < order.length) {
			s.snapshot.turnIndex = next;
			this.currentTurn = order[next];
			await this.beginTurn();
		} else {
			s.snapshot.turnIndex = 0;
			await this.completeRound();
		}
	}

	private async completeRound(): Promise<void> {
		const s = this.session;
		const summary = await this.narratorPrompt(
			`第 ${s.snapshot.round} 轮讨论结束。请简短总结本轮的进展与焦点（不要泄露真相）。`,
		);
		this.emitPublic({
			type: "narrator",
			roleName: "主持人",
			text: summary,
			round: s.snapshot.round,
		});
		s.snapshot.round += 1;
		// 每轮重置调查额度：每人每回合限调查 1 次
		s.snapshot.usedInvestigation = {};
		this.touch();
		if (s.snapshot.round > s.snapshot.maxRounds) {
			await this.startVoting();
		} else {
			this.emitPublic({
				type: "system",
				text: `第 ${s.snapshot.round} 轮讨论开始。`,
				round: s.snapshot.round,
			});
			this.currentTurn = s.snapshot.order[0];
			await this.beginTurn();
		}
	}

	// ---------- 投票 / 揭晓 ----------

	private async startVoting(): Promise<void> {
		const s = this.session;
		this.setPhase("voting");
		this.emitPublic({
			type: "system",
			text: "讨论结束，进入投票阶段。请所有玩家秘密投出你认为的真凶（或弃权）。",
		});
		for (const roleId of s.snapshot.order) {
			if (roleId === s.snapshot.humanRoleId) continue;
			await this.runAiVote(roleId);
		}
		await this.maybeFinishVoting();
	}

	private async runAiVote(roleId: string): Promise<void> {
		const s = this.session;
		const agent = s.roles[roleId];
		const role = this.role(roleId);
		let voted = false;
		try {
			await agent.prompt(
				`现在是投票阶段。请使用 vote 工具：target 填你认为的真凶的角色 id；若弃权填 null。`,
			);
			voted = s.snapshot.votes[roleId] !== undefined;
		} catch (e) {
			this.emitPublic({ type: "system", text: `角色 ${role.name} 投票出错: ${(e as Error).message}` });
		}
		// 区分主动弃权与投票失败：
		// - 已通过工具记录（含显式 null）=> 视为正常投票/弃权。
		// - 未记录 => 兜底记为 null（投票失败，按弃权处理并记录日志）。
		if (s.snapshot.votes[roleId] === undefined) {
			s.snapshot.votes[roleId] = null;
			if (voted) {
				// 理论上不应发生：已投票却无记录，记入系统事件便于排查。
				this.emitPublic({ type: "system", text: `角色 ${role.name} 投票记录丢失，按弃权处理。` });
			}
		}
		this.emitPublic({ type: "vote", roleId, roleName: role.name, text: "已投票" });
		this.touch();
		await this.maybeFinishVoting();
	}

	private async maybeFinishVoting(): Promise<void> {
		const s = this.session;
		if (s.snapshot.phase !== "voting") return;
		const allVoted = s.snapshot.order.every((r) => s.snapshot.votes[r] !== undefined);
		if (allVoted) await this.reveal();
	}

	private async reveal(): Promise<void> {
		const s = this.session;
		const script = s.script;
		const votes = s.snapshot.votes;
		const counts: Record<string, number> = {};
		for (const t of Object.values(votes)) {
			if (!t) continue;
			counts[t] = (counts[t] ?? 0) + 1;
		}
		const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);
		const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
		const topRole = top ? top[0] : null;
		const topCount = top ? top[1] : 0;
		// 严格多数（> 半数有效票）才能投出真凶。平票/并列最高票时无人获得严格多数，
		// 此时按规则视为"未抓住真凶"，凶手阵营获胜。
		const culpritVotedOut = topRole === script.truth.culprit && topCount > totalVotes / 2;
		const winner = culpritVotedOut ? "innocents" : "culprit";

		this.setPhase("reveal");
		const culprit = this.role(script.truth.culprit);
		const revealText = await this.narratorPrompt(
			`投票结束，现在揭晓真相。请完整揭晓：真凶是「${culprit.name}」，动机是 ${script.truth.motive}，手法是 ${script.truth.method}，并叙述完整时间线。`,
		);
		this.emitPublic({ type: "narrator", roleName: "主持人", text: revealText });
		this.emitPublic({
			type: "game_end",
			winner,
			votes,
			truth: script.truth,
			text: winner === "innocents" ? "真凶被投出，好人阵营获胜！" : "真凶逃脱，凶手阵营获胜！",
		});
		s.snapshot.winner = winner;
		this.setPhase("finished");
	}

	// ---------- 工具宿主 ----------

	makeToolHost(role: Role): ToolHost {
		const engine = this;
		return {
			roleId: role.id,
			roleName: role.name,
			phase: () => engine.session.snapshot.phase,
			validTargets: () => engine.session.script.roles.map((r) => r.id),
			locationIds: () => engine.session.script.locations.map((l) => l.id),
			snapshotAccess: () => ({
				usedInvestigation: engine.session.snapshot.usedInvestigation,
				roleClues: engine.session.snapshot.roleClues,
			}),
			hasInvestigated: () => engine.session.snapshot.usedInvestigation[role.id] === true,
			recordPublic: (partial) => engine.emitPublic(partial),
			recordPrivate: (to, partial) => engine.emitPrivate(to, partial),
			resolveInvestigation: (target) => engine.resolveInvestigation(role.id, target),
			recordVote: (target) => {
				const s = engine.session;
				if (s.snapshot.phase !== "voting") return;
				if (s.snapshot.votes[role.id] === undefined) {
					s.snapshot.votes[role.id] = target;
					engine.emitPublic({
						type: "vote",
						roleId: role.id,
						roleName: role.name,
						text: "已投票",
					});
					engine.touch();
				}
			},
			clueText: (clueId) => engine.clueText(clueId),
			roleNameOf: (id) => engine.role(id).name,
		};
	}
}
