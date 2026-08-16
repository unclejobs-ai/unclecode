import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgentOpsStore } from "@unclecode/agentops-db";
import {
  CONTEXT_DESK_GROUPS,
  CONTEXT_DESK_PANES,
  resolveContextDeskGroup,
} from "@unclecode/contracts";
import {
  createContextPacketView,
  selectContextPacketFromStore,
} from "@unclecode/context-broker";

/**
 * Context Desk — structured object model + registry projection.
 *
 * The desk renders three panes over a *grouped* packet: every packet item
 * resolves to exactly one group, and the packet carries the provider registry
 * manifest so the Sources pane can attribute an item to the provider that
 * produced it. This suite pins the canonical mapping and the projection
 * boundary (clone in, no stored-only fields out).
 */

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = join(tmpdir(), `unclecode-context-desk-${prefix}-${process.pid}-${tempDirs.length}`);
  tempDirs.push(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  const store = createAgentOpsStore({ home: makeTempDir("home") });
  store.addProject({ id: "proj_desk", name: "Desk", repoPath: "/repos/desk" });
  return store;
}

/** Every category a ContextPacketViewItem may carry. */
const PACKET_SOURCE_CATEGORIES = [
  "workspace",
  "workspace-guidance",
  "provider-system-prompt",
  "loop-trail",
  "condensed-history",
  "memory",
  "bridge",
  "runtime",
  "attachment",
  "system",
  "user",
];

/**
 * Canonical category → Context Desk group. This preserves the shipped grouping
 * from work-shell-context-inspector-suggestion.ts: `system` stays with project
 * instructions, `bridge` is conversation, and `other` is the unknown-category
 * fallback only — no canonical category lands there.
 */
const CANONICAL_CATEGORY_GROUPS = {
  workspace: "guidance",
  "workspace-guidance": "guidance",
  "provider-system-prompt": "guidance",
  system: "guidance",
  bridge: "conversation",
  "condensed-history": "conversation",
  user: "conversation",
  memory: "memory",
  "loop-trail": "tools",
  runtime: "tools",
  attachment: "attachments",
};

const STORED_ONLY_ITEM_FIELDS = [
  "projectId",
  "content",
  "sha256",
  "turnLastSeen",
  "createdAt",
  "updatedAt",
  "expiresAt",
];

const PROVENANCE_FIELDS = ["kind", "sourceId", "uri", "scope", "providerId", "sha256"];

// ── Structured object model ──────────────────────────────────────────

test("context desk exposes the exact Groups → Sources → Preview pane tuple", () => {
  assert.deepEqual(CONTEXT_DESK_PANES, ["groups", "sources", "preview"]);
});

test("context desk group descriptors are the canonical ordered set", () => {
  assert.deepEqual(
    CONTEXT_DESK_GROUPS.map((group) => [group.id, group.label]),
    [
      ["guidance", "Guidance"],
      ["conversation", "Conversation"],
      ["memory", "Memory"],
      ["tools", "Tools"],
      ["attachments", "Attachments"],
      ["other", "Other"],
    ],
  );

  for (const group of CONTEXT_DESK_GROUPS) {
    assert.ok(Array.isArray(group.categories), `group ${group.id} needs categories`);
  }

  // `other` is the unknown-category fallback; it claims no canonical category.
  assert.deepEqual(CONTEXT_DESK_GROUPS.at(-1).categories, []);
});

test("group descriptors partition every packet source category exactly once", () => {
  const seen = [];
  for (const group of CONTEXT_DESK_GROUPS) {
    for (const category of group.categories) {
      assert.ok(
        PACKET_SOURCE_CATEGORIES.includes(category),
        `unknown category ${category} on group ${group.id}`,
      );
      assert.equal(seen.includes(category), false, `category ${category} claimed twice`);
      seen.push(category);
      assert.equal(CANONICAL_CATEGORY_GROUPS[category], group.id);
    }
  }
  assert.deepEqual([...seen].sort(), [...PACKET_SOURCE_CATEGORIES].sort());
});

test("resolveContextDeskGroup maps every canonical category to its group", () => {
  for (const category of PACKET_SOURCE_CATEGORIES) {
    assert.equal(
      resolveContextDeskGroup(category),
      CANONICAL_CATEGORY_GROUPS[category],
      `category ${category} resolved to the wrong group`,
    );
  }
});

test("resolveContextDeskGroup falls back to 'other' for unknown categories", () => {
  assert.equal(resolveContextDeskGroup("not-a-category"), "other");
});

// ── Registry projection ──────────────────────────────────────────────

function seedDeskSources(store) {
  store.upsertContextSource({
    id: "guidance-1",
    projectId: "proj_desk",
    category: "workspace-guidance",
    label: "AGENTS.md",
    content: "Prefer small reversible diffs.",
    reason: "repo instructions",
    salience: 0.9,
    tokenEstimate: 20,
  });
  store.upsertContextSource({
    id: "mem-1",
    projectId: "proj_desk",
    category: "memory",
    label: "scoped memory",
    content: "remember this",
    reason: "scoped memory",
    salience: 0.8,
    tokenEstimate: 30,
  });
  store.upsertContextSource({
    id: "rt-1",
    projectId: "proj_desk",
    category: "runtime",
    label: "live trace",
    content: "trace event",
    reason: "live work-shell trace",
    salience: 0.6,
    tokenEstimate: 10,
  });
}

function deskManifests() {
  return [
    {
      providerId: "workspace-guidance",
      categories: ["workspace-guidance"],
      refresh: "on-change",
      trustTier: "project",
    },
    {
      providerId: "memory",
      categories: ["memory"],
      refresh: "on-turn",
      trustTier: "builtin",
    },
    {
      providerId: "runtime",
      categories: ["runtime"],
      refresh: "on-turn",
      trustTier: "builtin",
    },
  ];
}

test("selectContextPacketFromStore projects the provider registry onto the packet", () => {
  const store = makeStore();
  seedDeskSources(store);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_desk",
    tokenBudget: 10_000,
    turnIndex: 1,
    providers: deskManifests(),
  });

  assert.ok(packet.registry, "packet must carry a registry when providers are supplied");
  assert.deepEqual(packet.registry.providers, deskManifests());
});

test("projected registry providers are cloned away from the caller's manifests", () => {
  const store = makeStore();
  seedDeskSources(store);

  const manifests = deskManifests();
  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_desk",
    tokenBudget: 10_000,
    turnIndex: 1,
    providers: manifests,
  });

  const projected = packet.registry.providers;
  assert.notEqual(projected, manifests);
  assert.notEqual(projected[0], manifests[0]);
  assert.notEqual(projected[0].categories, manifests[0].categories);

  manifests.push({
    providerId: "smuggled",
    categories: ["bridge"],
    refresh: "manual",
    trustTier: "user",
  });
  manifests[0].categories.push("bridge");
  manifests[1].providerId = "mutated";

  assert.deepEqual(packet.registry.providers, deskManifests());
});

test("registry projection keeps manifest fields only, never provider internals", () => {
  const store = makeStore();
  seedDeskSources(store);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_desk",
    tokenBudget: 10_000,
    turnIndex: 1,
    providers: [
      {
        providerId: "memory",
        categories: ["memory"],
        refresh: "on-turn",
        trustTier: "builtin",
        sync: async () => ["mem-1"],
        store,
        secretToken: "must-not-escape",
      },
    ],
  });

  const [provider] = packet.registry.providers;
  assert.deepEqual(Object.keys(provider).sort(), [
    "categories",
    "providerId",
    "refresh",
    "trustTier",
  ]);
  assert.equal(JSON.stringify(packet).includes("must-not-escape"), false);
});

test("projected items carry their desk group", () => {
  const store = makeStore();
  seedDeskSources(store);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_desk",
    tokenBudget: 10_000,
    turnIndex: 1,
    providers: deskManifests(),
  });

  const groups = new Map(packet.included.map((item) => [item.id, item.group]));
  assert.equal(groups.get("guidance-1"), "guidance");
  assert.equal(groups.get("mem-1"), "memory");
  assert.equal(groups.get("rt-1"), "tools");

  for (const item of [...packet.included, ...packet.excluded]) {
    assert.equal(item.group, resolveContextDeskGroup(item.category), `item ${item.id}`);
  }
});

test("item provenance.providerId links to the registered provider for its category", () => {
  const store = makeStore();
  seedDeskSources(store);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_desk",
    tokenBudget: 10_000,
    turnIndex: 1,
    providers: deskManifests(),
  });

  const registeredIds = new Set(packet.registry.providers.map((provider) => provider.providerId));
  const byId = new Map(packet.included.map((item) => [item.id, item]));

  assert.equal(byId.get("guidance-1").provenance.providerId, "workspace-guidance");
  assert.equal(byId.get("mem-1").provenance.providerId, "memory");
  assert.equal(byId.get("rt-1").provenance.providerId, "runtime");

  for (const item of packet.included) {
    assert.ok(
      registeredIds.has(item.provenance.providerId),
      `item ${item.id} points at an unregistered provider ${item.provenance.providerId}`,
    );
    const provider = packet.registry.providers.find(
      (candidate) => candidate.providerId === item.provenance.providerId,
    );
    assert.ok(
      provider.categories.includes(item.category),
      `provider ${provider.providerId} does not declare category ${item.category}`,
    );
  }
});

test("registry linkage does not leak stored-only source metadata into items", () => {
  const store = makeStore();
  seedDeskSources(store);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_desk",
    tokenBudget: 10_000,
    turnIndex: 1,
    providers: deskManifests(),
  });

  for (const item of packet.included) {
    for (const field of STORED_ONLY_ITEM_FIELDS) {
      assert.equal(
        Object.hasOwn(item, field),
        false,
        `item ${item.id} leaked stored-only field ${field}`,
      );
    }
    for (const key of Object.keys(item.provenance)) {
      assert.ok(
        PROVENANCE_FIELDS.includes(key),
        `item ${item.id} provenance leaked registry-only field ${key}`,
      );
    }
  }
});

test("packet item projection canonicalizes a forged group from its category", () => {
  const packet = createContextPacketView({
    id: "packet-desk-boundary",
    generatedAt: "2026-08-11T00:00:00.000Z",
    included: [
      {
        id: "mem-1",
        category: "memory",
        label: "scoped memory",
        reason: "scoped memory",
        group: "tools",
        arbitraryInternalField: "must not escape",
      },
    ],
    excluded: [],
    warnings: [],
    preview: [],
  });

  assert.deepEqual(packet.included[0], {
    id: "mem-1",
    category: "memory",
    label: "scoped memory",
    reason: "scoped memory",
    group: "memory",
  });
});

// ── Backward compatibility ───────────────────────────────────────────

test("omitting provider input keeps the packet registry-free and backward compatible", () => {
  const store = makeStore();
  seedDeskSources(store);

  const packet = selectContextPacketFromStore({
    store,
    projectId: "proj_desk",
    tokenBudget: 10_000,
    turnIndex: 1,
  });

  assert.equal(packet.registry, undefined);
  assert.equal(Object.hasOwn(packet, "registry"), false);
  assert.equal(packet.version, 1);
  assert.ok(packet.included.length >= 3);

  const byId = new Map(packet.included.map((item) => [item.id, item]));
  assert.equal(byId.get("mem-1").provenance.providerId, "crp:memory");
  assert.equal(byId.get("mem-1").group, "memory");
  assert.equal(byId.get("guidance-1").group, "guidance");
});
