type ChangedFileSignals = {
  readonly hasSourceFiles: boolean;
  readonly hasTestFiles: boolean;
  readonly hasConfigFiles: boolean;
  readonly hasOnlyDocs: boolean;
  readonly hasMeaningfulFiles: boolean;
};

export function resolveRunnableScripts(
  requestedScripts: readonly string[],
  availableScripts: ReadonlySet<string>,
  changedFiles: readonly string[],
): readonly string[] {
  const resolved: string[] = [];

  for (const script of requestedScripts) {
    if (script === "test") {
      const expandedTests = resolveTargetedTestScripts(changedFiles, availableScripts);
      if (expandedTests.length > 0) {
        for (const expanded of expandedTests) {
          if (!resolved.includes(expanded)) {
            resolved.push(expanded);
          }
        }
        continue;
      }
    }

    if (availableScripts.has(script) && !resolved.includes(script)) {
      resolved.push(script);
    }
  }

  return resolved;
}

export function selectChangedFileAwareScripts(
  scripts: readonly string[],
  changedFiles: readonly string[],
): readonly string[] {
  if (changedFiles.length === 0) {
    return scripts;
  }

  const signals = analyzeChangedFiles(changedFiles);
  if (!signals.hasMeaningfulFiles || signals.hasOnlyDocs) {
    return [];
  }

  if (signals.hasTestFiles && !signals.hasSourceFiles && !signals.hasConfigFiles) {
    return scripts.filter((script) => isTestScript(script) || !isKnownGuardianScript(script));
  }

  return scripts.filter((script) => shouldRunGuardianScript(script, signals));
}

export function isSourceFile(file: string): boolean {
  return /\.(c|m)?[jt]sx?$/.test(file) && !isTestFile(file);
}

function analyzeChangedFiles(changedFiles: readonly string[]): ChangedFileSignals {
  const normalized = normalizeChangedFiles(changedFiles);
  const hasSourceFiles = normalized.some((file) => isSourceFile(file));
  const hasTestFiles = normalized.some((file) => isTestFile(file));
  const hasConfigFiles = normalized.some((file) => isConfigFile(file));
  const hasMeaningfulFiles = hasSourceFiles || hasTestFiles || hasConfigFiles;
  const hasOnlyDocs =
    !hasMeaningfulFiles && normalized.length > 0 && normalized.every((file) => isDocLikeFile(file));

  return {
    hasSourceFiles,
    hasTestFiles,
    hasConfigFiles,
    hasOnlyDocs,
    hasMeaningfulFiles,
  };
}

function shouldRunGuardianScript(script: string, signals: ChangedFileSignals): boolean {
  if (!isKnownGuardianScript(script)) {
    return true;
  }

  if (isLintScript(script)) {
    return signals.hasSourceFiles || signals.hasTestFiles || signals.hasConfigFiles;
  }

  if (isTypecheckScript(script)) {
    return signals.hasSourceFiles || signals.hasConfigFiles;
  }

  if (isTestScript(script)) {
    return signals.hasSourceFiles || signals.hasTestFiles || signals.hasConfigFiles;
  }

  if (isBuildScript(script)) {
    return signals.hasSourceFiles || signals.hasConfigFiles;
  }

  return true;
}

function isKnownGuardianScript(script: string): boolean {
  return isLintScript(script) || isTypecheckScript(script) || isTestScript(script) || isBuildScript(script);
}

function isLintScript(script: string): boolean {
  return /(^|:)(lint|format:check)$/.test(script) || script === "lint";
}

function isTypecheckScript(script: string): boolean {
  return /(^|:)(check|typecheck|tsc)$/.test(script);
}

function isTestScript(script: string): boolean {
  return /(^|:)(test|test:unit|test:integration)$/.test(script);
}

function isBuildScript(script: string): boolean {
  return /(^|:)build$/.test(script);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)/.test(file) || /\.(test|spec)\.(c|m)?[jt]sx?$/.test(file);
}

function isConfigFile(file: string): boolean {
  const base = file.split("/").at(-1) ?? file;
  return base === "package.json"
    || base === "package-lock.json"
    || base === "pnpm-lock.yaml"
    || base === "yarn.lock"
    || /^tsconfig(\..+)?\.json$/.test(base)
    || /^biome(\..+)?\.jsonc?$/.test(base)
    || /^eslint(\..+)?\./.test(base)
    || /^vitest(\..+)?\./.test(base)
    || /^jest(\..+)?\./.test(base)
    || /^vite(\..+)?\./.test(base)
    || /^next\.config\./.test(base);
}

function isDocLikeFile(file: string): boolean {
  return /\.(md|mdx|txt|rst)$/.test(file);
}

function normalizeChangedFiles(changedFiles: readonly string[]): readonly string[] {
  return changedFiles
    .map((file) => file.trim().replace(/\\/g, "/").toLowerCase())
    .filter((file) => file.length > 0);
}

function resolveTargetedTestScripts(
  changedFiles: readonly string[],
  availableScripts: ReadonlySet<string>,
): readonly string[] {
  const normalized = normalizeChangedFiles(changedFiles);
  if (normalized.length === 0) {
    return availableScripts.has("test") ? ["test"] : [];
  }

  const targeted: string[] = [];
  for (const file of normalized) {
    for (const script of resolveTargetedTestScriptsForFile(file)) {
      if (availableScripts.has(script) && !targeted.includes(script)) {
        targeted.push(script);
      }
    }
  }

  if (targeted.length > 0) {
    return targeted;
  }

  return availableScripts.has("test") ? ["test"] : [];
}

function resolveTargetedTestScriptsForFile(file: string): readonly string[] {
  const scripts: string[] = [];

  if (/(^|\/)(tests\/providers|packages\/providers\/)/.test(file)) {
    scripts.push("test:providers");
  }
  if (/(^|\/)(tests\/context-broker|packages\/context-broker\/)/.test(file)) {
    scripts.push("test:context-broker");
  }
  if (/(^|\/)(tests\/runtime-broker|packages\/runtime-broker\/)/.test(file)) {
    scripts.push("test:runtime-broker");
  }
  if (/(^|\/)(tests\/contracts|packages\/contracts\/|packages\/config-core\/)/.test(file)) {
    scripts.push("test:contracts");
  }
  if (/(^|\/)packages\/contracts\/src\/tui\.ts$/.test(file)) {
    scripts.push("test:tui");
  }
  if (/(^|\/)(tests\/performance)/.test(file)) {
    scripts.push("test:performance");
  }
  if (/(^|\/)(tests\/orchestrator|packages\/orchestrator\/)/.test(file)) {
    scripts.push("test:orchestrator");
  }
  if (/(^|\/)(tests\/tui|packages\/tui\/)/.test(file)) {
    scripts.push("test:tui");
  }
  if (/(^|\/)(tests\/commands|apps\/unclecode-cli\/src\/(command-router|program|interactive-launch-inputs|session-center-launcher|work-bootstrap|fast-cli|fast-sessions|startup-paths|operational)\.ts)/.test(file)) {
    scripts.push("test:commands");
  }
  if (/(^|\/)(tests\/work|apps\/unclecode-cli\/src\/(work-runtime|guardian-checks|runtime-coding-agent)\.ts|src\/)/.test(file)) {
    scripts.push("test:work");
  }
  if (/(^|\/)(packages\/tui\/|packages\/orchestrator\/src\/index\.ts|packages\/context-broker\/src\/index\.ts|packages\/providers\/src\/index\.ts|packages\/session-store\/src\/index\.ts|apps\/unclecode-cli\/src\/(interactive-launch-inputs|session-center-launcher|work-bootstrap|work-entry|work-runtime)\.ts|bin\/unclecode\.cjs|tsconfig\.work\.json)/.test(file)) {
    scripts.push("test:contracts");
  }

  return scripts;
}
