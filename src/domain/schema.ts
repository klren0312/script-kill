import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const TimelineEntrySchema = Type.Object({
	time: Type.String(),
	event: Type.String(),
});

export const ClueSchema = Type.Object({
	id: Type.String(),
	text: Type.String(),
});

export const RoleSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	public: Type.String(),
	secret: Type.String(),
	goal: Type.String(),
	clues: Type.Array(Type.String()),
	relationships: Type.Record(Type.String(), Type.String()),
});

export const LocationSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	description: Type.String(),
	clues: Type.Array(ClueSchema),
});

export const SettingSchema = Type.Object({
	time: Type.String(),
	place: Type.String(),
	background: Type.String(),
});

export const TruthSchema = Type.Object({
	culprit: Type.String(),
	motive: Type.String(),
	method: Type.String(),
	timeline: Type.Array(TimelineEntrySchema),
});

export const WinConditionSchema = Type.Object({
	roleId: Type.String(),
	condition: Type.String(),
});

export const WinConditionsSchema = Type.Object({
	culprit: Type.String(),
	innocent: Type.String(),
	perRole: Type.Array(WinConditionSchema),
});

export const ScriptSchema = Type.Object({
	schemaVersion: Type.String(),
	id: Type.String(),
	title: Type.String(),
	genre: Type.String(),
	description: Type.String(),
	playerCount: Type.Integer(),
	estimatedMinutes: Type.Integer(),
	difficulty: Type.String(),
	setting: SettingSchema,
	truth: TruthSchema,
	roles: Type.Array(RoleSchema),
	locations: Type.Array(LocationSchema),
	publicClues: Type.Array(ClueSchema),
	winConditions: WinConditionsSchema,
});

export type Script = Static<typeof ScriptSchema>;
export type Role = Static<typeof RoleSchema>;
export type Location = Static<typeof LocationSchema>;
export type Truth = Static<typeof TruthSchema>;
export type Clue = Static<typeof ClueSchema>;

export function validateScript(
	value: unknown,
): { ok: true; script: Script } | { ok: false; errors: string[] } {
	if (Value.Check(ScriptSchema, value)) {
		return { ok: true, script: value as Script };
	}
	const errors = [...Value.Errors(ScriptSchema, value)].map((e) => {
		const err = e as { path?: string; message?: string };
		return `${err.path || "(root)"}: ${err.message}`;
	});
	return { ok: false, errors };
}
