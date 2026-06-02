import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeTuiRendererId,
  resolveTuiRendererPlan,
  shouldUseOpenTuiRenderer,
} from "../../packages/tui/src/index.tsx";

test("TUI renderer plan defaults to the current Ink renderer", () => {
  const plan = resolveTuiRendererPlan({
    requestedRenderer: undefined,
    runtime: "node",
  });

  assert.equal(plan.renderer, "ink");
  assert.equal(plan.runtime, "node");
  assert.equal(plan.status, "active");
  assert.equal(plan.features.kittyKeyboardProtocol, false);
  assert.equal(shouldUseOpenTuiRenderer(plan), false);
});

test("OpenTUI renderer request is blocked under Node runtime", () => {
  const plan = resolveTuiRendererPlan({
    requestedRenderer: "opentui",
    runtime: "node",
  });

  assert.equal(plan.renderer, "opentui");
  assert.equal(plan.status, "blocked");
  assert.equal(plan.features.kittyKeyboardProtocol, true);
  assert.match(plan.reason ?? "", /Bun-only/);
  assert.equal(shouldUseOpenTuiRenderer(plan), false);
});

test("OpenTUI renderer request still requires the package and adapter under Bun", () => {
  const missingPackage = resolveTuiRendererPlan({
    requestedRenderer: "opentui",
    runtime: "bun",
  });
  assert.equal(missingPackage.status, "blocked");
  assert.match(missingPackage.reason ?? "", /not installed/);

  const missingAdapter = resolveTuiRendererPlan({
    requestedRenderer: "opentui",
    runtime: "bun",
    hasOpenTuiPackage: true,
  });
  assert.equal(missingAdapter.status, "blocked");
  assert.match(missingAdapter.reason ?? "", /adapter/);

  const active = resolveTuiRendererPlan({
    requestedRenderer: "opentui",
    runtime: "bun",
    hasOpenTuiPackage: true,
    hasOpenTuiAdapter: true,
  });
  assert.equal(active.status, "active");
  assert.equal(shouldUseOpenTuiRenderer(active), true);
});

test("unknown renderer ids normalize back to Ink", () => {
  assert.equal(normalizeTuiRendererId("opentui"), "opentui");
  assert.equal(normalizeTuiRendererId("unknown"), "ink");
  assert.equal(normalizeTuiRendererId(undefined), "ink");
});
