export type ExecFileResult = {
  stdout: string;
  stderr: string;
};

export type ExecFileLike = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<ExecFileResult>;

export type ReadFileLike = (path: string, encoding: BufferEncoding) => Promise<string>;

export type GuardianLspBridge = {
  checkAfterEdit(input: {
    readonly path: string;
    readonly content: string;
    readonly options?: {
      readonly timeoutMs?: number;
      readonly maxDiagnostics?: number;
    };
  }): Promise<{
    readonly status: "pass" | "fail" | "skipped" | "unavailable";
    readonly summary: string;
  }>;
};

export type GuardianExecutableCheck = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly summary: string;
};

export type GuardianExecutableCheckResult = {
  readonly checks: readonly GuardianExecutableCheck[];
  readonly summary: string;
};

