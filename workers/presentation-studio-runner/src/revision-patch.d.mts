import type { DashiJobInput, JsonObject } from "./types";

export declare function safeClaims(sourceMap: JsonObject): JsonObject[];

export declare function applySlideSpecPatch(
  spec: JsonObject | null,
  patch: JsonObject,
): JsonObject | null;

export declare function normalizeRevisionPatch(
  value: JsonObject | null,
  input: DashiJobInput,
): JsonObject | null;

export declare function applyRevisionPatch(
  input: DashiJobInput,
  specPatch: JsonObject,
): DashiJobInput | null;
