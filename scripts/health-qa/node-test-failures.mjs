import { stripVTControlCharacters } from "node:util";

/**
 * Preserve the useful TAP failure section even when hundreds of later passing
 * subtests would push it outside a generic tail. Output is bounded so a failed
 * health run remains readable in CI logs.
 */
export function extractNodeTestFailures(output, maxLines = 120) {
  if (!Number.isInteger(maxLines) || maxLines <= 0) return "";
  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  const aggregateIndex = lines.findLastIndex((line) => /^\s*✖ failing tests:\s*$/.test(line));
  if (aggregateIndex >= 0) {
    return lines.slice(aggregateIndex, aggregateIndex + maxLines).join("\n").trim();
  }

  const failures = [];
  for (let index = 0; index < lines.length && failures.length < maxLines; index += 1) {
    if (!/^\s*not ok \d+\b/.test(lines[index])) continue;
    if (/^\s*# Subtest: /.test(lines[index - 1] ?? "")) failures.push(lines[index - 1]);
    failures.push(lines[index]);
    for (index += 1; index < lines.length && failures.length < maxLines; index += 1) {
      const line = lines[index];
      if (/^\s*(?:# Subtest: |(?:not )?ok \d+\b|1\.\.\d+)/.test(line)) {
        index -= 1;
        break;
      }
      failures.push(line);
    }
  }
  return failures.join("\n").trim();
}
