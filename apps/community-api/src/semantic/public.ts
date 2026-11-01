import type { SemanticStore } from "./store.js";
export { semanticDisclosure } from "./disclosure.js";
export { assertSemanticStructure } from "./structure.js";
export type SemanticReader = Pick<SemanticStore, "get">;
