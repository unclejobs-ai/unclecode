import assert from "node:assert/strict";
import test from "node:test";

import { classifyWorkIntent } from "../../packages/orchestrator/src/turn-orchestrator.ts";
import {
  classifyWorkSafetyBoundary,
  resolveWorkerBudget,
} from "../../packages/orchestrator/src/work-agent.ts";

// Renamed from tests/contracts/orchestrator-multi-agent.contract.test.mjs.
// The classifier contract changed under T12-E1: ultrawork now routes
// short informational prompts to "simple" and only work-action prompts
// to "complex". The original file name still claimed ultrawork→complex.

test("classifyWorkIntent routes yolo action prompts to complex orchestration", () => {
  assert.equal(classifyWorkIntent("fix the login bug", "yolo"), "complex");
  assert.equal(classifyWorkIntent("implement dashboard", "yolo"), "complex");
  assert.equal(classifyWorkIntent("what is this?", "yolo"), "simple");
  assert.equal(classifyWorkIntent("explain the auth flow", "yolo"), "simple");
  assert.equal(classifyWorkIntent("/help", "yolo"), "simple");
  assert.equal(
    classifyWorkIntent("전체 점검하고 개선해", "default"),
    "complex",
  );
});

test("classifyWorkIntent routes ultrawork info prompts to simple and work prompts to complex", () => {
  assert.equal(classifyWorkIntent("hello", "ultrawork"), "simple");
  assert.equal(classifyWorkIntent("패러랠 모드가 뭐냐", "ultrawork"), "simple");
  assert.equal(
    classifyWorkIntent("what is parallel mode", "ultrawork"),
    "simple",
  );
  assert.equal(
    classifyWorkIntent("look around the project", "ultrawork"),
    "complex",
  );
  assert.equal(classifyWorkIntent("fix the login bug", "ultrawork"), "complex");
});

test("resolveWorkerBudget scales with mode aggressiveness", () => {
  const budgets = [
    resolveWorkerBudget("default"),
    resolveWorkerBudget("search"),
    resolveWorkerBudget("yolo"),
    resolveWorkerBudget("ultrawork"),
  ];
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(
      (budgets[i] ?? 0) >= (budgets[i - 1] ?? 0),
      `${budgets[i]} >= ${budgets[i - 1]}`,
    );
  }
});

test("safety boundary classifies English and Korean high-impact mutations with typed domains", () => {
  const cases = [
    ["reset user authentication", "auth"],
    ["사용자 인증을 재설정해", "auth"],
    ["rotate the production API credentials", "credentials"],
    ["프로덕션 API 자격 증명을 교체해", "credentials"],
    ["grant admin access to the support role", "access-control"],
    ["지원 역할에 관리자 접근 권한을 부여해", "access-control"],
    ["drop the customer database tables", "destructive-data"],
    ["고객 데이터베이스 테이블을 삭제해", "destructive-data"],
    ["change the billing plan", "billing"],
    ["결제 요금제를 변경해", "billing"],
    ["deploy the app to production", "deploy"],
    ["앱을 프로덕션에 배포해", "deploy"],
    ["publish the release", "release"],
    ["릴리스를 출시해", "release"],
  ];

  for (const [prompt, domain] of cases) {
    const boundary = classifyWorkSafetyBoundary(prompt);
    assert.ok(boundary.domains.includes(domain), `${prompt} should include ${domain}`);
    assert.equal(boundary.mutation, "mutation", prompt);
    assert.equal(boundary.risk, "high", prompt);
    assert.equal(boundary.requiresOrchestration, true, prompt);
  }
});

test("safety boundary distinguishes creator routing, read-only inspection, and ambiguous mutation", () => {
  for (const prompt of [
    "create an agent skill in skills/creator.md",
    "skills/creator.md에 에이전트 스킬을 만들어",
  ]) {
    const boundary = classifyWorkSafetyBoundary(prompt);
    assert.equal(boundary.creatorIntent, true, prompt);
    assert.ok(boundary.domains.includes("creator"), prompt);
    assert.equal(boundary.mutation, "mutation", prompt);
  }

  for (const prompt of [
    "show the current access control policy",
    "현재 접근 권한 정책을 보여줘",
  ]) {
    const boundary = classifyWorkSafetyBoundary(prompt);
    assert.equal(boundary.mutation, "read-only", prompt);
    assert.equal(boundary.requiresOrchestration, false, prompt);
  }

  for (const prompt of ["production auth settings", "프로덕션 인증 설정"]) {
    const boundary = classifyWorkSafetyBoundary(prompt);
    assert.equal(boundary.mutation, "ambiguous", prompt);
    assert.equal(boundary.requiresOrchestration, true, prompt);
  }
});
