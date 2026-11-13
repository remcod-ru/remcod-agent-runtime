import { describe, expect, it } from "vitest";

import * as sdk from "./index.js";

describe("@remcod/sdk public surface", () => {
  it("exposes only the curated authoring and runtime values", () => {
    expect(Object.keys(sdk).sort()).toEqual([
      "ProviderRegistry",
      "RuntimeFailure",
      "ScriptedModel",
      "canonicalJson",
      "createApprovalLedger",
      "createId",
      "createInMemoryRuntimeStore",
      "createPolicyEngine",
      "createRuntime",
      "createRuntimeHttpHandler",
      "defineAgent",
      "defineTool",
      "digestToolAction",
      "encodeRuntimeEventNdjson",
      "encodeRuntimeEventsNdjson",
      "sha256Hex",
      "z",
    ]);
  });
});
