export const REQUIRED_PROVENANCE_SUBSYSTEMS = [
  "contracts",
  "config-core",
  "session-store",
  "context-broker",
  "policy-engine",
  "providers-auth",
  "runtime-broker",
  "mcp-host",
  "orchestrator-research",
  "tui",
  "cli-release-surface",
];

const ALLOWED_STATUSES = new Set([
  "rewritten",
  "clean-room-adapted",
  "licensed-reuse",
  "inspiration-only",
]);

export function validateProvenanceManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Provenance manifest must be a JSON object.");
  }

  if (!manifest.product || typeof manifest.product !== "object") {
    throw new Error("Provenance manifest must include product metadata.");
  }

  if (manifest.product.name !== "UncleCode") {
    throw new Error("Provenance manifest product.name must be UncleCode.");
  }

  if (!manifest.subsystems || typeof manifest.subsystems !== "object" || Array.isArray(manifest.subsystems)) {
    throw new Error("Provenance manifest must include subsystem entries.");
  }

  const missing = REQUIRED_PROVENANCE_SUBSYSTEMS.filter(
    (name) => !(name in manifest.subsystems),
  );
  if (missing.length > 0) {
    throw new Error(`Missing provenance entries: ${missing.join(", ")}`);
  }

  for (const [name, entry] of Object.entries(manifest.subsystems)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid provenance entry for ${name}.`);
    }
    if (!ALLOWED_STATUSES.has(entry.status)) {
      throw new Error(`Invalid provenance status for ${name}: ${entry.status}`);
    }
    if (typeof entry.notes !== "string" || entry.notes.trim().length === 0) {
      throw new Error(`Missing provenance notes for ${name}.`);
    }
  }

  return manifest;
}
