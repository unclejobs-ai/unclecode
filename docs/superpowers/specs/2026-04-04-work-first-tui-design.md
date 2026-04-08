# Work-First UncleCode TUI Design

## Goal
Make UncleCode feel immediately responsive by opening directly into the work composer while keeping session center and operational surfaces available as secondary tools.

## Approved Direction
- `unclecode` starts in the work shell, not the session-center launcher.
- The session center remains available behind `unclecode tui` and work-shell secondary actions like `Esc` / `/sessions`.
- The primary header always exposes `model`, `reasoning`, `mode`, and `auth`.
- Reasoning support is visible even for unsupported models.
- Initial mode defaults are:
  - `default = medium`
  - `ultrawork = high`
  - `search = low`
  - `analyze = high`
- The main OpenAI model stays `gpt-5.4`; reasoning is adjustable instead of swapping down to a mini model by default.

## Interaction Model
- Composer gets first focus.
- Full-screen scene transitions are minimized.
- `Esc` and `/sessions` surface recent sessions without ejecting the user into a different startup flow.
- Secondary operational info (`sessions`, `status`, `tools`) appears alongside the composer instead of blocking it.

## Reasoning Model
- Reasoning is model-aware rather than hidden behind mode alone.
- Modes provide the initial default, but the session can override with `/reasoning low|medium|high|default`.
- Unsupported models still show `reasoning: unsupported` instead of hiding the control surface.

## Verification Intent
- Lock work-first startup selection in contract tests.
- Lock mode reasoning defaults and model reasoning support in provider/work tests.
- Keep browser OAuth, release-surface, setup/doctor, and integration coverage green while changing the startup path.
