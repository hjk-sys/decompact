---
name: open
description: Open the full history of every Claude Code and Codex session in the browser, including compacted messages and rewound branches.
disable-model-invocation: true
---

Run this and tell the user where the page was written:

```sh
npx -y decompact@latest $ARGUMENTS
```

With no arguments it builds the history site for every session and opens it. If the user gave a session id, run `npx -y decompact@latest open <id>` instead.
