---
name: recall
description: Read the part of the current session that compaction summarized away. Use after a compaction when the user refers to something from earlier ("the approach we tried before", "why did we decide X", "the error from earlier") and the details are not in your context, or when the user asks you to recall or recover earlier context.
---

# Recall compacted context

Claude Code keeps the full transcript on disk even after it compacts the conversation. `decompact` reads it back.

1. Export only the messages that compaction hid from the newest session in this folder:

   ```sh
   npx -y decompact@latest export latest --source claude --project "$PWD" --compacted-only --no-tools -o /tmp/decompact-recall.md
   ```

   If the user asked about a command, an error or a file change, run it again without `--no-tools` so tool calls and their output are included.

2. The file can be long. Search it with Grep for the words the user used, then Read only the sections around the matches. Read the whole file only if it is small.

3. Answer from what you found, and say that it came from the compacted part of the session. Quote the relevant lines when the exact wording matters, such as an error message or a decision.

If the export says no session matches, the session is from Codex or lives in another folder: run `npx -y decompact@latest list --limit 10` and use the right id instead of `latest`.

If $ARGUMENTS is not empty, focus the search on it.
