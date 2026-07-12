import assert from "node:assert/strict";
import test from "node:test";

import {
  attachPromptManifestToPacket,
  createContextPacketView,
  createPromptManifest,
  redactPromptManifestForSession,
  resolveContextProfile,
} from "@unclecode/context-broker";

function createPacket() {
  return createContextPacketView({
    id: "packet-1",
    generatedAt: "2026-07-12T00:00:00.000Z",
    included: [{
      id: "workspace-guidance",
      category: "workspace-guidance",
      label: "AGENTS.md",
      reason: "project policy",
      preview: "Use focused tests.",
      tokenEstimate: 12,
    }],
    excluded: [],
    warnings: [],
    preview: [],
  });
}

test("prompt manifests keep mandatory policy under every profile", () => {
  for (const profileId of ["build", "explore", "review"]) {
    const manifest = createPromptManifest({
      profile: resolveContextProfile(profileId),
      packet: createPacket(),
      policy: [
        { id: "system", label: "System policy", authority: "mandatory", digest: "sha256:abc" },
        { id: "workspace", label: "Workspace hints", authority: "profile-eligible", digest: "sha256:def" },
      ],
      systemPromptAppendix: "System policy text.",
      userPrompt: "inspect the manifest",
    });

    assert.equal(manifest.profileId, profileId);
    assert.deepEqual(manifest.policy.filter((source) => source.authority === "mandatory"), [
      { id: "system", label: "System policy", authority: "mandatory", digest: "sha256:abc" },
    ]);
  }
});

test("prompt manifest owns the exact provider payload and includes the user request once", () => {
  const manifest = createPromptManifest({
    profile: resolveContextProfile("build"),
    packet: createPacket(),
    policy: [{ id: "system", label: "System policy", authority: "mandatory", digest: "sha256:abc" }],
    systemPromptAppendix: "System policy text.",
    userPrompt: "write focused tests",
  });

  assert.match(manifest.providerPrompt, /<unclecode_context_packet id="packet-1"/);
  assert.equal(manifest.providerPrompt.split("write focused tests").length - 1, 1);
  assert.match(manifest.providerPrompt, /User request:\nwrite focused tests$/);
});

test("persisted packet manifest excludes provider-only instruction bodies", () => {
  const manifest = createPromptManifest({
    profile: resolveContextProfile("review"),
    packet: createPacket(),
    policy: [{ id: "system", label: "System policy", authority: "mandatory", digest: "sha256:abc" }],
    systemPromptAppendix: "private instruction body must not persist",
    userPrompt: "private user request must not persist",
  });
  const persisted = redactPromptManifestForSession(manifest);
  const packet = attachPromptManifestToPacket(manifest.packet, manifest);

  assert.equal(persisted.profileId, "review");
  assert.equal(packet.manifest?.id, manifest.id);
  assert.doesNotMatch(JSON.stringify({ persisted, packet }), /private instruction body|private user request/);
});
