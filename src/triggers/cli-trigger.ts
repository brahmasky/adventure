import { buildTypedTaskEvent } from "../domain/types.js";
import type { TypedTaskEvent } from "../domain/types.js";

export type CliTriggerResult =
  | { ok: true; event: TypedTaskEvent }
  | { ok: false; error: { code: "CLI_TRIGGER_INVALID"; message: string } };

function invalid(message: string): CliTriggerResult {
  return { ok: false, error: { code: "CLI_TRIGGER_INVALID", message } };
}

export function parseCliTrigger(args: string[]): CliTriggerResult {
  const [command, program, ...goalParts] = args;
  const goal = goalParts.join(" ").trim();

  if (command !== "run") {
    return invalid(`Unsupported command: ${command ?? "(missing)"}`);
  }

  if (!program?.trim()) {
    return invalid("Program is required");
  }

  if (!goal) {
    return invalid("Goal is required");
  }

  return {
    ok: true,
    event: buildTypedTaskEvent({
      source: "cli",
      type: "run",
      program,
      goal,
      requested_by: { kind: "user", id: "paco" },
      notify: { kind: "local" },
      idempotency_key: `cli:${program}:${goal}`,
      source_reference: `argv:${args.join(" ")}`
    })
  };
}
