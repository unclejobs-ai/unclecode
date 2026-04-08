export async function runWorkShellInlineCommand(
  args: readonly string[],
  runInlineCommand: (args: readonly string[]) => Promise<readonly string[]>,
  formatLine: (line: string) => string = (line) => line,
): Promise<{ readonly lines: readonly string[]; readonly failed: boolean }> {
  try {
    const lines = await runInlineCommand(args);
    return { lines: lines.length > 0 ? lines : ["No output."], failed: false };
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String((error as { stdout?: unknown }).stdout ?? "") : "";
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    const message = error instanceof Error ? error.message : String(error);
    const rawLines = [stdout.trim(), stderr.trim()].filter((line) => line.length > 0).flatMap((line) => line.split(/\r?\n/));
    const lines = (rawLines.length > 0 ? rawLines : [message]).map((line) => formatLine(line));
    return { lines, failed: true };
  }
}
