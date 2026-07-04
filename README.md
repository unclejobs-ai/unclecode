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

UncleCode는 **검사 가능한 컨텍스트**와 **숨겨진 오케스트레이션**을 전제로 한 repo-local 코딩 어시스턴트입니다. Cursor/Codex처럼 “채팅만 하는 터미널”이 아니라, **다음 모델 호출에 들어갈 패킷**을 사용자가 열어보고 조절할 수 있는 것이 핵심 차별점입니다.

### UncleCode가 다른 점

| 차별점 | 설명 |
| --- | --- |
| **Persistent shared context (`.unclecode/`)** | 프로젝트·세션·메모리·런북·QA 증거가 repo-local `.unclecode/`와 `~/.unclecode/state/`에 남습니다. 매 턴마다 처음부터 읽는 게 아니라, bootstrap → classify → packet 경로로 재사용합니다. |
| **Runbook-driven agent memory** | `packages/memory-bus`의 procedural SOP(`.unclecode/sop/`)와 `context-broker`의 scoped memory가 런북(`docs/runbooks/unclecode-normalization-runbook.md`) 규칙에 맞게 포함·제외·인용됩니다. 블랙박스 요약이 아닙니다. |
| **Hidden orchestration, polished TUI** | 모드 라우터(default / yolo / ultrawork / team-parallel)와 intent 분류(simple / complex / research)는 Rust+orchestrator에서 처리하고, Work Shell TUI는 대화·컴포저·`/context` 오버레이만 보여 줍니다. 백그라운드 워커·팀 레인은 사용자에게 노이즈 없이 동작합니다. |

### 런타임 레이어 (요약)

```
CLI / TUI (apps/unclecode-cli, packages/tui)
    ↓
Orchestrator (packages/orchestrator) — Work Shell, mode, team, turn routing
    ↓
Context Broker (packages/context-broker) — guidance, packet, memory, OMO
    ↓
Providers (packages/providers) — OpenAI, Anthropic, Gemini
```

Provider는 세 가지를 직접 지원합니다: OpenAI, Anthropic, Gemini. 터미널 UX는 하나로 유지하면서 모델 백엔드만 바꿉니다.

### 컨텍스트 부트스트랩 (한눈에)

세션 시작 시 UncleCode는 워크스페이스 소스를 수집해 **다음 호출 패킷**을 만듭니다.

1. **수집** — `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `UNCLECODE.md`, project skills, MCP registry(`.mcp.json`, `~/.unclecode/mcp.json`), scoped memory, OMO goal state
2. **분류** — `ContextPacketView`에 included / excluded / warnings (raw ledger·증거는 기본 제외)
3. **표시** — `/context` 오버레이 + 모델 prefix (`formatContextPacketPromptPrefix`)
4. **영속** — session-store, memory-bus SOP, agentops recorder, `.unclecode/qa/` 증거

상세 다이어그램: [`docs/design/persistent-context-architecture.md`](docs/design/persistent-context-architecture.md)

### 모드와 오케스트레이션

| 모드 | 역할 |
| --- | --- |
| `default` | 균형 잡힌 편집·검색·설명 |
| `yolo` | 셸 자동 실행 허용, 간결한 응답 |
| `ultrawork` | 깊은 검색, 백그라운드·병렬 작업 선호 |
| `analyze` / `search` / `plan` / `build` | 읽기 전용·계획·빌드 등 특화 프로필 |

프롬프트는 Rust `classify-intent`로 simple / complex / research로 나뉘고, complex는 bounded executor pool과 file-ownership으로 병렬 처리합니다. 팀 모드(`team run`)는 Hermes/acpx 레인으로 숨겨진 워커를 띄웁니다.

### 검증과 투명성

운영 게이트는 `npm run qa:health`입니다. 런타임 증거는 `.unclecode/qa/runtime-qa-latest.json`, 라이브 provider는 `.unclecode/qa/live-provider-latest.json`에 기록됩니다. 정상화 런북: [`docs/runbooks/unclecode-normalization-runbook.md`](docs/runbooks/unclecode-normalization-runbook.md)

### 설계 검토 (Devil's Advocate)

아키텍처의 약점·과설계·Cursor/Codex 대비 격차는 [`docs/design/devils-advocate-review-2026-07.md`](docs/design/devils-advocate-review-2026-07.md)에 정리되어 있습니다.

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
