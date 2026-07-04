import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeMemoryEntryFreshness,
  formatScopedMemoryTransparencyLine,
  parseScopedMemoryId,
} from "../../packages/context-broker/src/memory-transparency.ts";

describe("memory transparency", () => {
  it("parses scoped memory ids with ISO timestamps", () => {
    const parsed = parseScopedMemoryId("memory:session:2026-07-05T01:51:44.123Z:abc12345");
    assert.deepEqual(parsed, {
      scope: "session",
      timestamp: "2026-07-05T01:51:44.123Z",
    });
  });

  it("labels recent memory freshness from timestamps", () => {
    const now = Date.parse("2026-07-05T12:00:00.000Z");
    assert.equal(
      describeMemoryEntryFreshness("2026-07-05T11:30:00.000Z", now),
      "fresh",
    );
    assert.equal(
      describeMemoryEntryFreshness("2026-07-04T13:00:00.000Z", now),
      "recent",
    );
    assert.equal(
      describeMemoryEntryFreshness("2026-06-01T12:00:00.000Z", now),
      "aged",
    );
  });

  it("formats scope, citation, and freshness on one inspectable line", () => {
    const line = formatScopedMemoryTransparencyLine(
      {
        scope: "project",
        memoryId: "memory:project:2026-07-05T01:51:44.123Z:abc12345",
        summary: "Remember this workspace objective",
        timestamp: "2026-07-05T01:51:44.123Z",
      },
      Date.parse("2026-07-05T02:00:00.000Z"),
    );

    assert.match(line, /^project · Remember this workspace objective · cite memory:project:/);
    assert.match(line, / · fresh$/);
  });
});
