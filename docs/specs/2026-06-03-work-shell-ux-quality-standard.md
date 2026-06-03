# Work Shell UX Quality Standard

Date: 2026-06-03

This standard defines the default UncleCode terminal experience. The work shell should feel like a focused composer, not a debug log viewer.

## Default Transcript

- Show only user, assistant, and high-signal system messages in the conversation transcript.
- Do not show tool lifecycle rows such as `Step`, `search`, `read`, or `tool.completed` in the default transcript.
- Keep tool diagnostics in trace/context surfaces where they are useful, not between user and assistant messages.
- Render user turns as compact prompt lines, not full-width blocks.
- Render assistant turns with a distinct product label and readable prose spacing.

## Thinking And Progress

- Never expose raw thinking streams in the transcript.
- Use one lightweight reasoning label in the session header, for example `Reasoning · Balanced`.
- Use one active spinner per frame. Prefer the busy/status line; do not duplicate spinners in transcript, header, and footer.
- Use concise busy text such as `Working · search repo`, not multi-line trace dumps.

## Footer And Status

- The footer must prioritize `cwd`, model, mode, and auth state before keyboard hints.
- If width is constrained, drop optional hints before truncating core status.
- Do not leave dangling truncated hints such as `E…` when the core status can fit cleanly.
- Show quota/limit information only when a real provider/runtime source is available. Do not invent budget numbers.

## Interrupt, Queue, And Steering

- `Esc` while a turn is busy must interrupt the visible turn and abort the active provider/Rust request when possible.
- Late responses from an interrupted turn must not append assistant text or trace noise.
- Busy submits should either queue plain follow-ups or route queue commands; unsupported slash commands must be rejected with a clear system line.
- `/queue` and `/queue clear` are the canonical recovery commands after interruption.

## History

- The History screen is a resume surface, not a tutorial.
- Prefer terse labels such as `Saved conversation`, `State · idle`, and `Enter · resume with saved context`.
- Avoid repeated headings like `History detail` when `Conversation` describes the panel more directly.

## Verification Contract

- Source tests should run with `--conditions=source` so package exports do not read stale `dist`.
- Build before manually validating the installed CLI; source-only changes will not affect `apps/unclecode-cli/dist`.
- Any change that touches transcript rendering must include a regression check proving tool entries stay out of the default conversation.
