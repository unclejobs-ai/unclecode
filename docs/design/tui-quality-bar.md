# UncleCode TUI Quality Bar

Production-grade work shell checklist. Fail any item before shipping visual changes.

## Typography hierarchy

| Zone | Treatment | Must not |
| --- | --- | --- |
| Header | Bold provider title + muted hint + divider | Flat single-weight row |
| Status | Bold session facts · muted auth · accent activity | Duplicate footer cwd/model |
| Conversation | Tinted role badges + body text | Heavy cards, rail glyph spam |
| Composer | Hint row + light prompt deck + `›` prefix | Double borders, raw paths in hints |
| Footer | cwd + one context chip only | Model/auth/mode repetition |

## Color palette

- User intent: sky (`--accent-user`)
- Assistant / busy default: teal (`--accent-assistant`)
- Parallel / ultrawork busy: sky accent on activity
- Warnings / paused queue: amber (`--status-warning`)
- Tool trace (when explicit): olive (`--accent-tool`)
- No orange chrome, no purple AI gradients

## Conversation

- [ ] User: `◇ You · message` compact first line; wrapped continuations indent only
- [ ] Assistant: `◈ UncleCode` badge row; body uses quiet indent, no `▌` rail
- [ ] System: muted body, dim `·` prefix
- [ ] Tool traces hidden from default transcript
- [ ] Korean/CJK multi-line wraps via display-width helpers
- [ ] No subtask JSON, reasoning deltas, or worker meta in transcript

## Busy / parallel / streaming

- [ ] Single spinner in status strip (100ms frame step)
- [ ] Elapsed time while busy (`1.5s`, not raw ms spam)
- [ ] File paths humanized to `Reading files`; specific progress kept when useful
- [ ] No second lower activity row while busy
- [ ] Streaming assistant uses live cursor only on partial text

## Composer

- [ ] Hint row above prompt deck
- [ ] `─ prompt deck ─` divider (muted, not heavy box)
- [ ] `›` input prefix tinted by state (slash=user, busy=assistant, queue=warning)
- [ ] Footer row under input: cwd · context chip
- [ ] `/context`, `/mode` slash descriptions in Korean (product copy)

## Verification

```bash
npm run test:tui
node --disable-warning=ExperimentalWarning --conditions=source --import tsx --test tests/contracts/tui-work-shell.contract.test.mjs
cd packages/tui && npx tsc --noEmit
```

Target: **86+** unit tests, **46/46** contract tests, tsc clean.
