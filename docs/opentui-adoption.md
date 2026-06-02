# OpenTUI Adoption Notes

## Decision

Keep Ink as the default renderer for the Node/npm CLI and add an explicit
OpenTUI renderer capability gate. OpenTUI is attractive for UncleCode's rough
TUI edges, but the official quick start currently targets Bun, while
UncleCode's published CLI path is Node based.

## Why OpenTUI Fits

- Renderer: flexbox layout and a retained element tree can reduce manual width
  juggling in the Session Center and composer dock.
- Input: kitty keyboard protocol, focus events, mouse events, and bracketed
  paste map directly to our current problem areas.
- Testing: a memory renderer gives us a better path for deterministic TUI
  layout assertions than screenshot-only validation.

## Current Gate

The code-level gate lives in `packages/tui/src/renderer-capabilities.ts`.
`UNCLECODE_TUI_RENDERER=opentui` is recognized, but it remains blocked unless:

1. The TUI is running under Bun.
2. `@opentui/react` is packaged.
3. An UncleCode OpenTUI adapter exists.

Until all three are true, the CLI must keep rendering through Ink.

## Migration Path

1. Keep the current WorkShell and Session Center on Ink while the Rust port
   stabilizes.
2. Move volatile surfaces toward renderer-neutral view models:
   composer input, slash/model picker, Session Center history/context detail,
   and approval/status strips.
3. Add a Bun-only experimental entrypoint for `UNCLECODE_TUI_RENDERER=opentui`.
4. Port the composer and picker first. They benefit most from OpenTUI keyboard
   and paste events.
5. Only make OpenTUI the default after smoke/e2e coverage proves parity for
   resize, CJK input, backspace/delete, Esc session navigation, model selection,
   auth approval, and streamed response status.

## Product Angle

The goal is not "same CLI on a newer renderer." The UncleCode angle is a
history/context-aware coding shell: the Esc screen should make saved
conversation history, workspace guidance, bridge summaries, and memory sources
legible as separate but connected context layers.
