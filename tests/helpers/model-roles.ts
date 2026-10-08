import { readFileSync } from "node:fs";
import { parseOmpCatalog } from "../../src/omp/model-catalog.js";
import type { CatalogModel } from "../../src/omp/model-roles.js";

/** A neutral `omp --profile houge models --json` catalog (tests/fixtures/omp-models.json): every list id, both Antigravity generations, the twins. */
export const CATALOG_FIXTURE = new URL("../fixtures/omp-models.json", import.meta.url).pathname;

/** The fixture through the real parser, so a test sees exactly what the resolver would. */
export function fixtureCatalog(): CatalogModel[] {
  const c = parseOmpCatalog(readFileSync(CATALOG_FIXTURE, "utf8"));
  if (!c) throw new Error("the catalog fixture did not parse");
  return c;
}
