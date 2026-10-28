# decompact

**See everything your coding agent forgot.**

[![npm](https://img.shields.io/npm/v/decompact)](https://www.npmjs.com/package/decompact)
[![downloads](https://img.shields.io/npm/dw/decompact)](https://www.npmjs.com/package/decompact)
[![CI](https://github.com/hjk-sys/agentlog/actions/workflows/ci.yml/badge.svg)](https://github.com/hjk-sys/agentlog/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/decompact)](LICENSE)

When Claude Code compacts a conversation or you rewind it, the earlier messages vanish from the app. They're still in log files on your disk, though. `decompact` reads those files and gives you your whole history back as a fast, searchable local web page.

```sh
npx decompact
```

![Searching every session, then opening one with its compacted and rewound messages recovered](https://raw.githubusercontent.com/hjk-sys/agentlog/main/docs/demo.gif)

## Why

Compaction keeps a long session going, but the agent and the app both lose the details: why you made a decision, the error you already fixed, the approach you rewound away. People keep asking for a way to get that back ([#27242](https://github.com/anthropics/claude-code/issues/27242), [#3138](https://github.com/anthropics/claude-code/issues/3138)). The data was never deleted, only hidden. `decompact` shows it.

- **Recovers compacted context.** Everything above a compaction is shown and labeled, along with the summary the agent was left with.
- **Shows rewound branches.** Prompts you edited or rewound away stay next to the path you took.
- **Searches across every session.** It covers every project, every prompt and every answer.
- **Works with Claude Code and Codex CLI.** Subagent transcripts are linked from the tool call that started them.
- **Exports to Markdown.** Attach a full transcript to a bug report or keep it in your notes.
- **Shares one session as a single HTML file.** Common secrets (API keys, tokens, passwords) and your home folder path are redacted.
- **Claude Code plugin.** `/decompact:recall` lets Claude read what compaction hid from the session you're in.
- **Private by design.** No server, no account, no network. It writes static HTML to `~/.decompact`, and nothing leaves your machine.

## Usage

```sh
npx decompact                  # build the site and open it
npx decompact list             # sessions, newest first
npx decompact open 3f2a        # open one session by id prefix
npx decompact export 3f2a > session.md
npx decompact share 3f2a       # one HTML file you can send to someone
```

Use `latest` instead of an id for the newest session. Add `--project <text>` to get the newest session in one project.

| Option | What it does |
| --- | --- |
| `--source claude` / `--source codex` | Only one agent |
| `--project <text>` | Only sessions whose folder contains `<text>` |
| `--out <dir>` | Write the site somewhere other than `~/.decompact` |
| `--no-open` | Build without opening a browser |
| `export --branches` | Include rewound branches |
| `export --main-only` | Leave out compacted messages |
| `export --thinking` | Include thinking blocks |
| `export --no-tools` | Leave out tool calls |
| `export --compacted-only` | Only the messages compaction hid |
| `share -o <file>` | Where to write the shared page (default `decompact-<id>.html`) |
| `share --no-redact` | Keep secrets and paths as they are |

`share` takes the same `--main-only`, `--branches`, `--thinking` and `--no-tools` flags as `export`. Redaction catches common key and token formats, not everything, so skim the file before you send it.

## Claude Code plugin

```sh
claude plugin marketplace add hjk-sys/agentlog
claude plugin install decompact@decompact
```

| Command | What it does |
| --- | --- |
| `/decompact:recall [topic]` | Claude reads the compacted part of the current session and answers from it. Claude also uses it on its own when you ask about something it no longer remembers. |
| `/decompact:open` | Builds the history site and opens it |
| `/decompact:share` | Saves the current session as one redacted HTML file |

It reads `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR`) and `~/.codex/sessions` (or `$CODEX_HOME`). Point it elsewhere with `--claude-dir` and `--codex-dir`. It needs Node.js 18 or newer.

## How it works

Claude Code appends every event to a JSONL file and never deletes from it. Each entry has a `uuid` and a `parentUuid`, so the file is a tree:

- The **live conversation** is the path from the newest entry back to the root.
- A **rewind or edit** starts a new child from an earlier message, so the old path stays in the file as a dead branch.
- A **compaction** writes a `compact_boundary` entry that cuts the parent link but keeps a `logicalParentUuid`, so everything before it is still reachable.

`decompact` walks that tree and labels each message as live, compacted or rewound. Codex rollouts are a flat list with `compacted` markers, handled the same way.

## Library

```js
import { loadSessions, toMarkdown } from 'decompact';

for (const s of loadSessions({ sources: ['claude'] })) {
  console.log(s.title, s.compactions, s.branches);
}
```

## Contributing

Log formats change between agent versions. If a session renders wrong, please open an issue with your agent version and, if you can, a redacted snippet of the log.

```sh
npm install
npm test
node scripts/demo-data.mjs /tmp/demo   # made-up sessions for trying changes
CLAUDE_CONFIG_DIR=/tmp/demo/claude CODEX_HOME=/tmp/demo/codex node dist/cli.js
```

## License

MIT
