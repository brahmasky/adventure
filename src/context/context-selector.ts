export interface ContextSelectionInput {
  run_id: string;
  requester_id: string;
  program: string;
  contract_hash: string;
}

export interface ContextPack {
  context_pack_id: string;
  included: string[];
  excluded: string[];
  token_estimate: number;
}

export function selectContext(input: ContextSelectionInput): ContextPack {
  return {
    context_pack_id: `ctx_${input.run_id}`,
    included: [
      "memory/core/houge.md",
      `task-contract:${input.contract_hash}`,
      `programs/${input.program}.md`
    ],
    excluded: [`memory/user/${input.requester_id}.md`, "memory-catalog:*"],
    token_estimate: 1200
  };
}
