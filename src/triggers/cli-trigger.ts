import { buildTypedTaskEvent } from "../domain/types.js";
import type { TypedTaskEvent, TypedTaskEventInput } from "../domain/types.js";

export type CliTriggerResult =
  | { ok: true; event: TypedTaskEvent }
  | { ok: false; error: { code: "CLI_TRIGGER_INVALID"; message: string } };

function invalid(message: string): CliTriggerResult {
  return { ok: false, error: { code: "CLI_TRIGGER_INVALID", message } };
}

export function parseCliTrigger(args: string[]): CliTriggerResult {
  const [command, program, ...goalParts] = args;

  if (command !== "run") {
    return invalid(`Unsupported CLI command: ${command ?? "(missing)"}`);
  }

  if (!program?.trim()) {
    return invalid("Program is required");
  }

  const parsed = parseRunGoal(program, goalParts);
  if (!parsed.ok) {
    return parsed;
  }

  if (!parsed.goal) {
    return invalid("Goal is required");
  }

  const input: TypedTaskEventInput = {
    source: "cli",
    type: "run",
    program,
    goal: parsed.goal,
    requested_by: { kind: "user", id: "paco" },
    notify: { kind: "local" },
    idempotency_key: parsed.idempotency_key ?? `cli:${program}:${parsed.goal}`,
    source_reference: parsed.source_reference ?? `argv:${args.join(" ")}`
  };
  if (parsed.metadata) input.metadata = parsed.metadata;
  if (parsed.payload !== undefined) input.payload = parsed.payload;

  return {
    ok: true,
    event: buildTypedTaskEvent(input)
  };
}

type ParsedRunGoal =
  | {
      ok: true;
      goal: string;
      idempotency_key?: string;
      source_reference?: string;
      metadata?: Record<string, unknown>;
      payload?: unknown;
    }
  | { ok: false; error: { code: "CLI_TRIGGER_INVALID"; message: string } };

function invalidRunGoal(message: string): ParsedRunGoal {
  return { ok: false, error: { code: "CLI_TRIGGER_INVALID", message } };
}

function parseRunGoal(program: string, parts: string[]): ParsedRunGoal {
  if (!parts.some((part) => part.startsWith("--"))) {
    return { ok: true, goal: parts.join(" ").trim() };
  }

  let objective: string | undefined;
  let idempotencyKey: string | undefined;
  let source = "cli";
  let payload: unknown;

  for (let index = 0; index < parts.length; index += 2) {
    const option = parts[index];
    const value = parts[index + 1];
    if (!option?.startsWith("--")) return invalidRunGoal(`Unexpected positional argument: ${option}`);
    if (value === undefined || value.startsWith("--")) return invalidRunGoal(`Missing value for ${option}`);

    if (option === "--objective") objective = value.trim();
    else if (option === "--idempotency-key") idempotencyKey = value.trim();
    else if (option === "--source") source = value.trim();
    else if (option === "--payload") {
      try {
        payload = JSON.parse(value) as unknown;
      } catch {
        return invalidRunGoal("Payload must be valid JSON");
      }
    } else {
      return invalidRunGoal(`Unknown option: ${option}`);
    }
  }

  if (source !== "cli" && source !== "local") {
    return invalidRunGoal(`Unsupported source: ${source}`);
  }

  const payloadReference = payload === undefined ? "" : `;payload:${JSON.stringify(payload)}`;
  const parsed: ParsedRunGoal = {
    ok: true,
    goal: objective ?? "",
    source_reference: `argv:run ${program};source:${source}${payloadReference}`,
    metadata: { source }
  };
  if (idempotencyKey) parsed.idempotency_key = idempotencyKey;
  if (payload !== undefined) parsed.payload = payload;
  return parsed;
}
