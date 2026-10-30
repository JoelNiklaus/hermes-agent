# Local patches on `joel`

`joel` = upstream Hermes + the patches below. Every patch goes upstream (own PR, or an existing upstream PR whose commits we use). Drop a row once upstream has merged it. Workflow: the `hermes-development` skill.

| Patch | Commits on `joel` | Upstream | Status | Tests |
|---|---|---|---|---|
| Desktop: a chat switch right after Enter cancels the send and puts the text back into the draft | b729ee20e8 (fork: 4e74d7ff79 on main) | issue #131421; PR #131423 (conflicts with main, misses the post-journal abort; our commit offered in a comment) | open | `cd apps/desktop && npx vitest run --project ui src/app/session/hooks/use-prompt-actions/submit-navigate-away.test.tsx src/app/session/hooks/use-prompt-actions/index.test.tsx src/app/chat/composer/hooks/use-composer-submit.restore-scoping.test.tsx src/app/session/hooks/session-context-drift.test.ts` |
| browser_exec: a second, never-closed blank tab per named session on a shared browser | 17b997e65c, 1eaa6e6eaa (= PR #91528) | issue #142484; PR #91528 | open | `pytest tests/tools/test_browser_use_cli.py` |
