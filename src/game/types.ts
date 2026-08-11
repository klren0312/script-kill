import type { Agent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, MutableModels } from "@earendil-works/pi-ai";
import type { Script, Truth } from "../domain/schema.js";

export type Phase = "setup" | "reading" | "discussion" | "voting" | "reveal" | "finished";

export type EventType =
	| "narrator"
	| "speak"
	| "whisper"
	| "investigate"
	| "show"
	| "vote"
	| "phase"
	| "turn"
	| "system"
	| "game_end";

export interface GameEvent {
	id: string;
	at: number;
	type: EventType;
	roleId?: string;
	roleName?: string;
	target?: string | null;
	targetName?: string;
	text?: string;
	phase?: Phase;
	/** "public" 或某个角色 id（私密事件只发给该角色） */
	scope?: "public" | string;
	winner?: string;
	votes?: Record<string, string | null>;
	truth?: Truth;
	round?: number;
	currentTurn?: string | null;
	humanTurn?: boolean;
}

/** 给某位玩家看的公开快照：不含 AI 角色私密事件、不含任何 Agent 转录。 */
export interface PublicSnapshot {
	id: string;
	scriptId: string;
	phase: Phase;
	createdAt: number;
	updatedAt: number;
	humanRoleId: string;
	order: string[];
	turnIndex: number;
	round: number;
	maxRounds: number;
	currentTurn: string | null;
	usedInvestigation: Record<string, boolean>;
	roleClues: Record<string, string[]>;
	votes: Record<string, string | null>;
	publicEvents: GameEvent[];
	/** 当前人类玩家自己的私密事件（字段名避免与快照中的 privateEvents 混淆） */
	myPrivateEvents: GameEvent[];
	winner?: string;
}

/** 可序列化的完整游戏快照（含所有 Agent 转录）。 */
export interface GameSnapshot {
	id: string;
	scriptId: string;
	phase: Phase;
	createdAt: number;
	updatedAt: number;
	humanRoleId: string;
	order: string[];
	turnIndex: number;
	round: number;
	maxRounds: number;
	currentTurn: string | null;
	usedInvestigation: Record<string, boolean>;
	usedLocationClues: Record<string, number>;
	roleClues: Record<string, string[]>;
	votes: Record<string, string | null>;
	publicEvents: GameEvent[];
	privateEvents: Record<string, GameEvent[]>;
	narratorTranscript: AgentMessage[];
	roleTranscripts: Record<string, AgentMessage[]>;
	winner?: string;
}

/** 运行时会话：可序列化快照 + 持有 Agent 实例与依赖。 */
export interface GameSession {
	snapshot: GameSnapshot;
	script: Script;
	narrator: Agent;
	roles: Record<string, Agent>;
	currentTurn: string | null;
	deps: EngineDeps;
	lock: Promise<void>;
}

export interface EngineDeps {
	onEvent: (event: GameEvent) => void;
	persist: () => void;
	models: MutableModels;
	narratorModel: Model<any>;
	narratorThinking: ThinkingLevel;
	playerModel: Model<any>;
	playerThinking: ThinkingLevel;
}
