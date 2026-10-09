import { readFileSync } from "node:fs";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";
import { RoleResolver, type OverrideKey } from "../../src/omp/role-resolver.js";
import type { RunStore } from "../../src/run/run-store.js";

/** A neutral `omp --profile houge models --json` catalog (tests/fixtures/omp-models.json): every list id, both Antigravity generations, the twins. */
export const CATALOG_FIXTURE = new URL("../fixtures/omp-models.json", import.meta.url).pathname;

/** The fixture through the real parser, so a test sees exactly what the resolver would. */
export function fixtureCatalog(): CatalogModel[] {
  const c = parseOmpCatalog(readFileSync(CATALOG_FIXTURE, "utf8"));
  if (!c) throw new Error("the catalog fixture did not parse");
  return c;
}

/** A resolver over `catalog` with Paco's overrides already recorded (as `/models set` would), the catalog read once. */
export async function pinnedRoles(
  store: RunStore, catalog: CatalogModel[], overrides: Partial<Record<OverrideKey, string>> = {}, env: () => NodeJS.ProcessEnv = () => ({})
): Promise<RoleResolver> {
  for (const [key, pattern] of Object.entries(overrides)) store.recordModelRoleOverride({ key: key as OverrideKey, pattern: pattern ?? "", actor: "test" });
  const roles = new RoleResolver({ store, env, readCatalog: async () => catalog });
  await roles.refreshCatalog();
  return roles;
}
