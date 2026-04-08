import assert from "node:assert/strict";
import test from "node:test";

import { resolveFastCliPath } from "../../apps/unclecode-cli/src/fast-cli.ts";

test("resolveFastCliPath recognizes lightweight operator startup paths", () => {
  assert.equal(resolveFastCliPath(["auth", "status"]), "auth-status");
  assert.equal(resolveFastCliPath(["auth", "status", "--json"]), undefined);
  assert.equal(resolveFastCliPath(["doctor"]), "doctor");
  assert.equal(resolveFastCliPath(["doctor", "--verbose"]), "doctor");
  assert.equal(resolveFastCliPath(["doctor", "--json"]), "doctor-json");
  assert.equal(resolveFastCliPath(["doctor", "--verbose", "--json"]), "doctor-json");
  assert.equal(resolveFastCliPath(["doctor", "--help"]), undefined);
  assert.equal(resolveFastCliPath(["setup"]), "setup");
  assert.equal(resolveFastCliPath(["setup", "--help"]), undefined);
  assert.equal(resolveFastCliPath(["mode", "status"]), "mode-status");
  assert.equal(resolveFastCliPath(["mode", "set", "default"]), undefined);
  assert.equal(resolveFastCliPath(["sessions"]), "sessions");
  assert.equal(resolveFastCliPath(["sessions", "--json"]), undefined);
  assert.equal(resolveFastCliPath(["config", "explain"]), "config-explain");
  assert.equal(resolveFastCliPath(["config", "explain", "--json"]), undefined);
  assert.equal(resolveFastCliPath(["/auth", "status"]), undefined);
});
