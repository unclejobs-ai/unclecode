export function shouldLaunchDefaultWorkSession(input: {
  args: readonly string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): boolean {
  return input.args.length === 0 && input.stdinIsTTY && input.stdoutIsTTY;
}
