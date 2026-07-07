export type ContextPacketSourceCategory =
  | "workspace"
  | "workspace-guidance"
  | "provider-system-prompt"
  | "loop-trail"
  | "memory"
  | "bridge"
  | "runtime"
  | "attachment"
  | "system"
  | "user";

export type ContextPacketViewItem = {
  readonly id: string;
  readonly category: ContextPacketSourceCategory;
  readonly label: string;
  readonly reason: string;
  readonly preview?: string | undefined;
  readonly tokenEstimate?: number | undefined;
  readonly sourceCount?: number | undefined;
  readonly salience?: number | undefined;
  readonly includedInModel?: boolean | undefined;
};

export type ContextPacketWarningSeverity = "info" | "warning" | "error";

export type ContextPacketViewWarning = {
  readonly code: string;
  readonly message: string;
  readonly severity: ContextPacketWarningSeverity;
};

export type ContextPacketSourceCounts = {
  readonly included: number;
  readonly excluded: number;
  readonly warnings: number;
};

export type ContextPacketView = {
  readonly id: string;
  readonly version: 1;
  readonly generatedAt: string;
  readonly title: string;
  readonly included: readonly ContextPacketViewItem[];
  readonly excluded: readonly ContextPacketViewItem[];
  readonly warnings: readonly ContextPacketViewWarning[];
  readonly preview: readonly string[];
  readonly sourceCounts: ContextPacketSourceCounts;
  readonly tokenEstimate: number;
};

export type CreateContextPacketViewInput = {
  readonly id: string;
  readonly generatedAt: string;
  readonly title?: string | undefined;
  readonly included: readonly ContextPacketViewItem[];
  readonly excluded: readonly ContextPacketViewItem[];
  readonly warnings: readonly ContextPacketViewWarning[];
  readonly preview: readonly string[];
};
