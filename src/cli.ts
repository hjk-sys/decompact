#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findSession, loadSessions } from './discover.js';
import { toMarkdown } from './markdown.js';
import { fmtDate, pageKey, summarize, writeSite } from './render.js';
import type { Session, Source } from './types.js';

const HELP = `decompact: browse your full Claude Code and Codex history, including
everything compaction hid and every branch you rewound.

Usage
  decompact                    Build the history site and open it in your browser
  decompact list               List sessions, newest first
  decompact open <id>          Open one session (id or unique prefix)
  decompact export <id>        Print a session as Markdown

Options
  --out <dir>                 Where to write the site (default ~/.decompact)
  --no-open                   Build without opening a browser
  --source <claude|codex>     Only one agent
  --project <text>            Only sessions whose folder contains <text>
  --limit <n>                 list: show at most n sessions (default 30)
  --json                      list: print JSON
  -o, --output <file>         export: write to a file instead of stdout
  --main-only                 export: leave out compacted messages
  --branches                  export: include rewound branches
  --thinking                  export: include thinking blocks
  --no-tools                  export: leave out tool calls
  --claude-dir <dir>          Claude Code config dir (default $CLAUDE_CONFIG_DIR or ~/.claude)
  --codex-dir <dir>           Codex home (default $CODEX_HOME or ~/.codex)
  -v, --version               Print version
  -h, --help                  Show this help
`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set(['out', 'source', 'project', 'limit', 'output', 'o', 'claude-dir', 'codex-dir']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      let key = a.replace(/^-+/, '');
      let value: string | boolean = true;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (VALUE_FLAGS.has(key)) {
        value = argv[++i] ?? '';
      }
      flags[key] = value;
    } else {
      positional.push(a);
    }
  }
  const cmd = positional.shift() ?? 'build';
  return { cmd, positional, flags };
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function load(flags: Args['flags']): Session[] {
  const source = str(flags.source);
  if (source && source !== 'claude' && source !== 'codex') fail(`--source must be "claude" or "codex"`);
  let errors = 0;
  const sessions = loadSessions({
    claudeDir: str(flags['claude-dir']),
    codexDir: str(flags['codex-dir']),
    sources: source ? [source as Source] : undefined,
    project: str(flags.project),
    onError: () => errors++,
  });
  if (errors) process.stderr.write(`decompact: skipped ${errors} log file${errors === 1 ? '' : 's'} that could not be read\n`);
  return sessions;
}

function pick(sessions: Session[], query: string | undefined): Session {
  if (!query) fail('Give a session id or prefix. Run `decompact list` to see them.');
  const found = findSession(sessions, query);
  if (!found) fail(`No session matches "${query}".`);
  if (Array.isArray(found)) fail(`"${query}" matches ${found.length} sessions. Use a longer prefix:\n${found.slice(0, 10).map((s) => `  ${s.id}  ${s.title}`).join('\n')}`);
  return found;
}

function openInBrowser(file: string) {
  const url = pathToFileURL(file).href;
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => process.stdout.write(`Open this in your browser: ${url}\n`));
    child.unref();
  } catch {
    process.stdout.write(`Open this in your browser: ${url}\n`);
  }
}

function fail(message: string): never {
  process.stderr.write(`decompact: ${message}\n`);
  process.exit(1);
}

function main() {
  const { cmd, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.h || flags.help || cmd === 'help') return void process.stdout.write(HELP);
  if (flags.v || flags.version) return void process.stdout.write(`${version()}\n`);

  const outDir = resolve(str(flags.out) ?? join(homedir(), '.decompact'));
  const shouldOpen = !flags['no-open'];

  switch (cmd) {
    case 'build': {
      const sessions = load(flags);
      if (!sessions.length) {
        fail('No Claude Code or Codex sessions found. Looked in ~/.claude/projects and ~/.codex/sessions (override with --claude-dir / --codex-dir).');
      }
      const site = writeSite(sessions, outDir);
      const totals = sessions.map(summarize).reduce((t, s) => ({ c: t.c + s.compacted, b: t.b + s.branched }), { c: 0, b: 0 });
      process.stdout.write(
        `decompact: ${sessions.length} sessions, ${totals.c} messages recovered from compaction, ${totals.b} on rewound branches\n` +
          `Wrote ${site.index}\n`,
      );
      if (shouldOpen) openInBrowser(site.index);
      return;
    }
    case 'list':
    case 'ls': {
      const sessions = load(flags);
      const limit = Number(str(flags.limit) ?? 30) || 30;
      const rows = sessions.slice(0, limit).map(summarize);
      if (flags.json) return void process.stdout.write(JSON.stringify(rows.map((r, i) => ({ id: sessions[i].id, ...r })), null, 2) + '\n');
      for (const [i, r] of rows.entries()) {
        const extra = [r.compacted ? `${r.compacted} compacted` : '', r.branched ? `${r.branched} rewound` : ''].filter(Boolean).join(', ');
        process.stdout.write(
          `${sessions[i].id.slice(0, 8)}  ${fmtDate(r.updated).padEnd(16)}  ${r.source.padEnd(6)}  ${r.project.slice(0, 18).padEnd(18)}  ${r.title.slice(0, 70)}${extra ? `  (${extra})` : ''}\n`,
        );
      }
      if (sessions.length > limit) process.stdout.write(`… ${sessions.length - limit} more (use --limit)\n`);
      return;
    }
    case 'open':
    case 'show': {
      const sessions = load(flags);
      const s = pick(sessions, positional[0]);
      const site = writeSite(sessions, outDir);
      const file = join(site.dir, 'sessions', `${pageKey(s)}.html`);
      process.stdout.write(`Wrote ${file}\n`);
      if (shouldOpen) openInBrowser(file);
      return;
    }
    case 'export': {
      const s = pick(load(flags), positional[0]);
      const md = toMarkdown(s, {
        compacted: !flags['main-only'],
        branches: Boolean(flags.branches),
        thinking: Boolean(flags.thinking),
        tools: !flags['no-tools'],
      });
      const output = str(flags.output) ?? str(flags.o);
      if (output) {
        writeFileSync(output, md);
        process.stderr.write(`Wrote ${resolve(output)}\n`);
      } else {
        process.stdout.write(md);
      }
      return;
    }
    default:
      fail(`Unknown command "${cmd}". Run \`decompact --help\`.`);
  }
}

main();
