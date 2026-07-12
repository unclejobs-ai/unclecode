import type {
  ContextPacketView,
  ContextProfile,
  PersistedPromptManifest,
  PromptManifest,
  PromptManifestPolicySource,
} from "@unclecode/contracts";

import { composeWorkShellTurnPromptFromPacket } from "./context-packet-view.js";

export type CreatePromptManifestInput = {
  readonly profile: ContextProfile;
  readonly packet: ContextPacketView;
  readonly policy: readonly PromptManifestPolicySource[];
  readonly systemPromptAppendix: string;
  readonly userPrompt: string;
};

export function createPromptManifest(input: CreatePromptManifestInput): PromptManifest {
  const policy = input.policy.map((source) => ({ ...source }));
  return {
    id: `${input.packet.id}:${input.profile.id}`,
    profileId: input.profile.id,
    createdAt: input.packet.generatedAt,
    policy,
    packet: input.packet,
    systemPromptAppendix: input.systemPromptAppendix,
    userPrompt: input.userPrompt,
    providerPrompt: composeWorkShellTurnPromptFromPacket({
      packet: input.packet,
      userPrompt: input.userPrompt,
    }),
  };
}

export function redactPromptManifestForSession(manifest: PromptManifest): PersistedPromptManifest {
  return {
    id: manifest.id,
    profileId: manifest.profileId,
    createdAt: manifest.createdAt,
    packetId: manifest.packet.id,
    policy: manifest.policy.map((source) => ({ ...source })),
    includedSourceCount: manifest.packet.sourceCounts.included,
    excludedSourceCount: manifest.packet.sourceCounts.excluded,
    tokenEstimate: manifest.packet.tokenEstimate,
  };
}

export function attachPromptManifestToPacket(
  packet: ContextPacketView,
  manifest: PromptManifest,
): ContextPacketView {
  if (manifest.packet.id !== packet.id) {
    throw new Error("Prompt manifest packet identity must match the packet it annotates.");
  }

  return {
    ...packet,
    manifest: redactPromptManifestForSession(manifest),
  };
}
