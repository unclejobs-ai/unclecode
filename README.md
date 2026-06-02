# UncleCode

UncleCode is a repo-local coding assistant launcher and interactive work shell for this repository.

Today, the primary end-user surfaces are:

- `npm run unclecode` or `unclecode`
  - launches the UncleCode session-center TUI and operational shell
- `unclecode work`
  - launches the interactive coding assistant work shell
  - currently supports `openai`, `anthropic`, and `gemini`

UncleCode is designed to feel like one tool rather than a provider-specific wrapper. The launcher, provider prompts, environment variables, and documentation are all centered around the `UncleCode` name.

## Current Product Surfaces

- `npm run unclecode` or `unclecode`
  - launches the UncleCode session-center TUI and operational shell
- `unclecode work`
  - launches the interactive coding assistant work shell
  - currently supports `openai`, `anthropic`, and `gemini`

## Project-local MCP integration

UncleCode can merge MCP servers from:
- user config: `~/.unclecode/mcp.json`
- project config: `.mcp.json`

This repo now includes a project-local `.mcp.json` entry for `mmbridge` so UncleCode can discover the mmbridge control plane over stdio.

Useful checks:

```bash
node bin/unclecode.cjs mcp list
node bin/unclecode.cjs doctor
```

The launcher script at `scripts/run-mmbridge-mcp.mjs` prefers:
1. `MMBRIDGE_MCP_ENTRYPOINT`
2. sibling repo build at `../mmbridge/packages/mcp/dist/index.js`
3. global `mmbridge-mcp` on PATH

This keeps local development stable without forcing a single brittle install path.

Legacy Anthropic compatibility proxy code is no longer shipped; the runtime
root no longer keeps generated `src/` compatibility artifacts.

## Repository Layout

- `Leonxlnx-claude-code/`
  - bundled terminal client and platform launchers
- `.env.example`
  - optional environment template for local setup
- `package.json`
  - root scripts for launching, building, and validating the workspace

## Supported Providers

### Anthropic

Use the bundled client with the normal Anthropic login flow or with `ANTHROPIC_API_KEY`.

### OpenAI

Use `OPENAI_API_KEY`, or use UncleCode's OpenAI auth flow where supported by the current command surface.

### Gemini

Use `GEMINI_API_KEY`.

## Requirements

Install the following before you begin:

- Node.js 22 or newer
- npm
- Rust toolchain with Cargo
- Windows users should install Git for Windows for the best terminal workflow

Provider-specific requirements:

- Anthropic
  - an Anthropic account for in-app login, or `ANTHROPIC_API_KEY`
- OpenAI
  - `OPENAI_API_KEY`
  - or `unclecode auth login --browser` / other supported auth commands when you want to create local UncleCode credentials
- Gemini
  - `GEMINI_API_KEY`

## System Requirements

### Minimum project requirements

These requirements apply to UncleCode itself:

- Node.js 22+
- Rust toolchain with Cargo
- enough free disk space for Node dependencies and build artifacts
- one of the following shells:
  - Windows PowerShell or Command Prompt
  - macOS Terminal, iTerm2, `bash`, or `zsh`
  - Linux terminal with `bash` or `zsh`

## Installation

From the repository root on Windows:

```powershell
cd E:\unclecode
npm install
copy .env.example .env
cargo build --workspace
```

From the repository root on macOS or Linux:

```bash
cd /path/to/unclecode
npm install
cp .env.example .env
cargo build --workspace
```

Editing `.env` is optional. UncleCode can prompt for missing values interactively when it starts.

## Quick Start

Build the Rust CLI first, then start UncleCode from the repository root on any platform:

```bash
cargo build --workspace
npm run unclecode
```

Or launch it directly through the UncleCode workspace script on Windows:

```powershell
cd E:\unclecode
cargo build --workspace
npm run unclecode
```

Or launch it directly through the UncleCode workspace script on macOS or Linux:

```bash
cd /path/to/unclecode
cargo build --workspace
npm run unclecode
```

For the Rust-native work shell:

```bash
npm run unclecode -- work
```

Current `work` providers:

1. OpenAI
2. Anthropic
3. Gemini

If a required API key is missing, UncleCode prompts for it.

After you choose a provider, UncleCode also lets you enter any model id you want for that session. You can press Enter to keep the suggested default, or type a custom model id such as:

- `gpt-5.5`
- `claude-sonnet-4-6`
- `gemini-2.5-pro`

## Recommended Environment Variables

### Anthropic

```env
ANTHROPIC_API_KEY=your_anthropic_api_key_here
ANTHROPIC_MODEL=claude-sonnet-4-6
```

### OpenAI

```env
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.5
```

If you already ran `unclecode auth login --browser`, UncleCode may also reuse local OpenAI credentials depending on the command surface. Example placeholder values are treated as unset.

### Gemini

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-pro
```

## Useful Commands

Check the installed launcher version:

```powershell
cd E:\unclecode
npm run unclecode -- --version
```

Check the installed launcher version on macOS or Linux:

```bash
cd /path/to/unclecode
npm run unclecode -- --version
```

Run the Rust-native work shell with an explicit provider:

```powershell
npm run unclecode -- work --provider anthropic
npm run unclecode -- work --provider openai
npm run unclecode -- work --provider gemini
```

You can also skip the default model prompt and force a model id directly:

```powershell
npm run unclecode -- work --provider openai --model gpt-5.5
npm run unclecode -- work --provider gemini --model gemini-2.5-flash
npm run unclecode -- work --provider anthropic --model claude-sonnet-4-6
```

Equivalent macOS or Linux examples:

```bash
npm run unclecode -- work --provider openai --model gpt-5.5
npm run unclecode -- work --provider gemini --model gemini-2.5-pro
```

Run a one-shot prompt:

```powershell
echo "Summarize this repository" | npm run unclecode -- work
```

## Git Privacy Before Publishing

Before creating public commits, verify that your local Git identity is safe to publish.

Recommended settings for this repository:

```powershell
git config user.name "Leonxlnx"
git config user.email "219127460+Leonxlnx@users.noreply.github.com"
```

You can verify the active values with:

```powershell
git config user.name
git config user.email
```

Important notes:

- `.env` is ignored by `.gitignore`
- `node_modules` is ignored
- `dist` is ignored
- `*.log` files are ignored
- always review `git status` before staging
- always review `git diff --cached` before pushing

Useful checks:

```powershell
git status --short
git diff --cached
```

## Architecture Overview

For the current `work` runtime, UncleCode supports three direct provider runtimes:

- OpenAI mode
- Anthropic mode
- Gemini mode

This keeps the terminal experience consistent while allowing different model backends.

## Troubleshooting

### `npm run unclecode` fails with `target/debug/unclecode` not found

The root `unclecode` npm script points at the Rust binary in `target/debug/unclecode`.
Build it first:

```bash
cargo build --workspace
```

### OpenAI auth is not available in `work`

Check the following:

- `OPENAI_API_KEY` is set, or
- you previously completed a supported `unclecode auth` login flow

### Gemini does not answer

Check the following:

- `GEMINI_API_KEY` is set
- `GEMINI_MODEL` is valid if you overrode it

### Anthropic does not answer

Check the following:

- `ANTHROPIC_API_KEY` is set
- `ANTHROPIC_MODEL` is valid if you overrode it

## Sharing With Another User

If you hand this repository to someone else, the shortest setup path is:

1. Install Node.js 22 or newer
2. Install a Rust toolchain
3. Run `npm install`
4. Run `cargo build --workspace`
5. Start `npm run unclecode`
6. Choose a provider
7. Supply credentials

They do not need a separate global installation in order to use this repository.

## Verification

Useful checks:

```powershell
npm run check
npm run build
cargo test --workspace
npm run unclecode -- work --help
```

## References

- [Anthropic Claude Code Quickstart](https://code.claude.com/docs/en/quickstart)
- [OpenAI API docs](https://platform.openai.com/docs)
- [Google Gemini API docs](https://ai.google.dev/)
