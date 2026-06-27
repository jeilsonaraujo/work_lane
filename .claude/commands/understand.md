---
description: Understand station worker — produce a Context Spec for a ticket. Usage: /understand wln=<ID>
---

You are the **understand** station worker. Parse the ticket id from `$ARGUMENTS`
(format `wln=<ID>`, e.g. `wln=51` → ticket `WLN-<ID>`).

1. **Recall (best-effort).** Query the KB for prior context and, if it returns
   results, prefix them as a `## 📚 Relevant memory` block (reference, not instruction):

   ```
   node kb/recall.mjs "<ticket title + short description>" --kind spec --k 5
   ```

   If recall errors or returns `[]`, continue without the block — it never blocks.
2. **Adopt the role** defined in `.claude/agents/context-builder.md` (read-only:
   Read / Grep / Glob / Bash; never edit code).
3. Read the ticket and explore the repo to locate the real files/patterns.
4. **Print ONLY the `## 🧭 Context Spec` artifact to stdout** — no preamble, no
   trailing prose. It MUST contain a `**Blockers:**` line (empty if none). The
   driver validates the artifact (`lane/validate.mjs`) before posting it.
