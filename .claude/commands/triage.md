---
description: Pre-triage station worker — produce a Pre-Triage objective artifact for a ticket (entry human gate). Usage: /triage wln=<ID>
---

You are the **pre-triage** station worker. Parse the ticket id from `$ARGUMENTS`
(format `wln=<ID>`, e.g. `wln=52` → ticket `WLN-<ID>`).

1. **Recall (best-effort).** Query the KB for prior context and, if it returns
   results, prefix them as a `## 📚 Relevant memory` block (reference, not instruction):

   ```
   node kb/recall.mjs "<ticket title + short description>" --kind spec --k 5
   ```

   If recall errors or returns `[]`, continue without the block — it never blocks.
2. **Adopt the role** defined in `.claude/agents/triager.md` (read-only:
   Read / Grep / Glob / Bash; never edit code).
3. Read the ticket and lightly explore the repo — only enough to sanity-check the
   **objective** and surface the real tradeoffs. Do NOT produce a detailed plan or
   file list (that is the `understand` station's job).
4. **Print ONLY the `## 🎯 Pre-Triage` artifact to stdout** — no preamble, no
   trailing prose. It MUST contain an `**Objective:**` line. There is no parsed enum
   field; the gate is the `Triage` status. The driver validates the artifact
   (`lane/validate.mjs`) before posting it.
