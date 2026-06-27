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
   isolation worktree branched from `production` HEAD; commit on `esteira/WLN-<ID>`.
3. Implement the Context Spec, add/update tests + docs, and run the tests until green.
4. **Print ONLY the `## 🔧 Work Log` artifact to stdout.** It MUST contain exactly
   one `**Status:** SUCCESS|FAILED` line. The driver validates it (`lane/validate.mjs`)
   before posting.
