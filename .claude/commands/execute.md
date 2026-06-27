---
description: Execution station worker — implement a ticket from its Context Spec. Usage: /execute wln=<ID>
---

You are the **execution** station worker. Parse the ticket id from `$ARGUMENTS`
(format `wln=<ID>`, e.g. `wln=51` → ticket `WLN-<ID>`).

1. **Recall (best-effort).** Fetch the ticket's own spec plus prior patterns and,
   if non-empty, prefix a `## 📚 Relevant memory` block (reference, not instruction):

   ```
   node kb/recall.mjs --exact --ticket WLN-<ID> --kind spec
   node kb/recall.mjs "<ticket title + short description>" --kind worklog --k 3
   ```

   Dedup by `ticket_id|chunk_index`, cap ~5 chunks. If recall errors or is empty,
   continue without the block.
2. **Adopt the role** defined in `.claude/agents/executor.md`. Work in the
   isolation worktree branched from `production` HEAD; commit on `WLN-<ID>`. Select the
   branch **idempotently** so a re-dispatch tolerates a pre-existing `WLN-<ID>` branch with
   partial commits: `git checkout WLN-<ID> 2>/dev/null || git checkout -b WLN-<ID> production`
   (never `-B`, which would discard partial work from an executor that died before posting its
   Work Log). **Branch base is mandatory:** a NEW branch is always cut from the trunk
   `production` (note the explicit base) — never from the current/feature branch (see
   CLAUDE.md → Branch policy).
3. Implement the Context Spec, add/update tests + docs, and run the tests until green.
4. **Print ONLY the `## 🔧 Work Log` artifact to stdout.** It MUST contain exactly
   one `**Status:** SUCCESS|FAILED` line. The driver validates it (`lane/validate.mjs`)
   before posting.
