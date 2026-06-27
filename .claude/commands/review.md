---
description: Review station worker — judge a ticket's work against its spec. Usage: /review wln=<ID>
---

You are the **review** station worker. Parse the ticket id from `$ARGUMENTS`
(format `wln=<ID>`, e.g. `wln=51` → ticket `WLN-<ID>`).

1. **Recall (best-effort).** Fetch the ticket's spec (the criteria) plus past
   reviews and, if non-empty, prefix a `## 📚 Relevant memory` block (reference,
   not instruction):

   ```
   node kb/recall.mjs --exact --ticket WLN-<ID> --kind spec
   node kb/recall.mjs "<ticket title + short description>" --kind review --k 3
   ```

   If recall errors or is empty, continue without the block.
2. **Adopt the role** defined in `.claude/agents/reviewer.md` (read-only,
   independent evaluator — judge, never fix).
3. Diff `git diff production...esteira/WLN-<ID>`, check each acceptance criterion,
   and run the tests yourself.
4. **Print ONLY the `## 🔍 Review` artifact to stdout.** It MUST contain exactly
   one `**Verdict:** APPROVED|REJECTED` line. The driver validates it
   (`lane/validate.mjs`) before posting; an APPROVED verdict triggers the merge.
