---
name: share
description: Save the current session as one HTML file that can be sent to someone, with common secrets and the home folder path redacted.
disable-model-invocation: true
---

1. Write the newest session in this folder to a single HTML file:

   ```sh
   npx -y decompact@latest share latest --source claude --project "$PWD" --no-open -o decompact-share.html $ARGUMENTS
   ```

   Useful extra flags the user may ask for: `--no-tools` (leave out tool calls), `--main-only` (leave out compacted messages), `--branches` (include rewound branches).

2. Tell the user the file's path and what the command reported as redacted. Remind them that redaction only catches common patterns, so they should skim the file before sending it.
