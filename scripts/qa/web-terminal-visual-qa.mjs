#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ANSI_SEQUENCE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripAnsi(value) {
  return value.replace(ANSI_SEQUENCE_PATTERN, "");
}

function createTerminalHtml(input) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111827;
      --panel: #172033;
      --line: #334155;
      --text: #dbeafe;
      --muted: #94a3b8;
      --accent: #67e8f9;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 18% 12%, rgba(103, 232, 249, 0.18), transparent 30rem),
        linear-gradient(135deg, #0f172a, var(--bg));
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 32px;
    }
    .meta {
      color: var(--muted);
      margin-bottom: 16px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 12px;
    }
    h1 {
      margin: 0 0 18px;
      color: var(--accent);
      font-size: 22px;
    }
    pre {
      overflow: auto;
      min-height: 520px;
      margin: 0;
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: color-mix(in srgb, var(--panel), transparent 8%);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
      white-space: pre-wrap;
      line-height: 1.42;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <main>
    <div class="meta">UncleCode terminal visual QA</div>
    <h1>${escapeHtml(input.title)}</h1>
    <pre>${escapeHtml(input.transcript)}</pre>
  </main>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const title = requireArg(args, "title");
  const sourceFile = path.resolve(requireArg(args, "from-file"));
  const evidenceDir = path.resolve(requireArg(args, "evidence-dir"));
  const rawTranscript = readFileSync(sourceFile, "utf8");
  const transcript = stripAnsi(rawTranscript).replace(/\r\n/g, "\n");

  mkdirSync(evidenceDir, { recursive: true });

  const transcriptFile = path.join(evidenceDir, "terminal.txt");
  const htmlFile = path.join(evidenceDir, "terminal.html");
  const metadataFile = path.join(evidenceDir, "metadata.json");
  const metadata = {
    title,
    sourceFile,
    evidenceDir,
    transcriptFile,
    htmlFile,
    lineCount: transcript.length === 0 ? 0 : transcript.split("\n").length,
    charCount: transcript.length,
    generatedAt: new Date().toISOString(),
  };

  writeFileSync(transcriptFile, transcript);
  writeFileSync(htmlFile, createTerminalHtml({ title, transcript }));
  writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
