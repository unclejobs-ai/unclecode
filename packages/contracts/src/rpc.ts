export const UNCLECODE_RPC_PROTOCOL = "unclecode.rpc.jsonl.v1" as const;
export const UNCLECODE_RPC_TRANSPORT = "stdio-jsonl" as const;

export type UnclecodeRpcFrame =
  | UnclecodeRpcReadyFrame
  | UnclecodeRpcCommandFrame
  | UnclecodeRpcResponseFrame
  | UnclecodeRpcEventFrame
  | UnclecodeRpcErrorFrame;

export type UnclecodeRpcReadyFrame = {
  readonly type: "ready";
  readonly protocol: typeof UNCLECODE_RPC_PROTOCOL;
  readonly transport: typeof UNCLECODE_RPC_TRANSPORT;
  readonly capabilities: readonly UnclecodeRpcCapability[];
};

export type UnclecodeRpcCommandFrame = {
  readonly type: "command";
  readonly id: string;
  readonly command: UnclecodeRpcCommand;
};

export type UnclecodeRpcResponseFrame = {
  readonly type: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
};

export type UnclecodeRpcErrorFrame = {
  readonly type: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: UnclecodeRpcError;
};

export type UnclecodeRpcEventFrame = {
  readonly type: "event";
  readonly event: UnclecodeRpcEvent;
};

export type UnclecodeRpcCapability =
  | "session.run"
  | "session.cancel"
  | "tool.call"
  | "auth.status"
  | "provider.route";

export type UnclecodeRpcCommand =
  | {
      readonly name: "session.run";
      readonly input: {
        readonly prompt: string;
        readonly cwd?: string;
        readonly providerId?: string;
        readonly modelId?: string;
      };
    }
  | {
      readonly name: "session.cancel";
      readonly input: {
        readonly sessionId: string;
        readonly reason?: string;
      };
    }
  | {
      readonly name: "auth.status";
      readonly input: {
        readonly providerId?: string;
      };
    }
  | {
      readonly name: "provider.route";
      readonly input: {
        readonly providerId: string;
        readonly modelId?: string;
      };
    }
  | {
      readonly name: "tool.result";
      readonly input: UnclecodeRpcToolResult;
    };

export type UnclecodeRpcEvent =
  | {
      readonly name: "session.started";
      readonly data: {
        readonly sessionId: string;
      };
    }
  | {
      readonly name: "session.delta";
      readonly data: {
        readonly sessionId: string;
        readonly role: "assistant" | "tool" | "system";
        readonly content: string;
      };
    }
  | {
      readonly name: "tool.call";
      readonly data: UnclecodeRpcToolCall;
    }
  | {
      readonly name: "session.completed";
      readonly data: {
        readonly sessionId: string;
        readonly exitCode: number;
      };
    };

export type UnclecodeRpcToolCall = {
  readonly sessionId: string;
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
};

export type UnclecodeRpcToolResult = {
  readonly sessionId: string;
  readonly callId: string;
  readonly content: string;
  readonly isError?: boolean;
};

export type UnclecodeRpcError = {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
};

export function encodeUnclecodeRpcFrame(frame: UnclecodeRpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function isUnclecodeRpcFrame(value: unknown): value is UnclecodeRpcFrame {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "ready") {
    return value.protocol === UNCLECODE_RPC_PROTOCOL && value.transport === UNCLECODE_RPC_TRANSPORT;
  }
  if (value.type === "command") {
    return typeof value.id === "string" && isRecord(value.command);
  }
  if (value.type === "response") {
    return typeof value.id === "string" && typeof value.ok === "boolean";
  }
  if (value.type === "event") {
    return isRecord(value.event);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
