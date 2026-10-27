import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { OrdinaryScopeInputSchema } from "./ordinary-authorization.ts";
import { ModelCallLimitSchema, ExecutionSecondsSchema } from "./delegate-machine.ts";
import { AGENT_NAME_PATTERN } from "./machine.ts";
import { englishProse } from "./internal-language.ts";
import { validGoalFilePath } from "./goal-files.ts";

export const AutomaticDelegateInputSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 4000 }),
  role: Type.Optional(Type.String({ pattern: AGENT_NAME_PATTERN, minLength: 1, maxLength: 64 })),
  files: OrdinaryScopeInputSchema.properties.files,
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 16 })),
  observations: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 16 })),
  maxModelCalls: Type.Optional(ModelCallLimitSchema), seconds: Type.Optional(ExecutionSecondsSchema),
}, { additionalProperties: false });
export type AutomaticDelegateInput = Static<typeof AutomaticDelegateInputSchema>;
export function validAutomaticInput(value: unknown): value is AutomaticDelegateInput {
  return Value.Check(AutomaticDelegateInputSchema, value) && englishProse(value.task) &&
    value.files.every(file => validGoalFilePath(file.path)) && new Set(value.files.map(file => file.path)).size === value.files.length &&
    [...value.constraints ?? [], ...value.observations ?? []].every(englishProse);
}
