import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeSession } from './claude.js';
import { parseCodexSession } from './codex.js';
import type { Session, Source } from './types.js';

export interface DiscoverOptions {
  claudeDir?: string;
  codexDir?: string;
  sources?: Source[];
  /** Only keep sessions whose working directory contains this text. */
  project?: string;
  onError?: (file: string, err: unknown) => void;
}

export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function defaultCodexDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function findClaudeLogs(claudeDir = defaultClaudeDir()): string[] {
  const root = join(claudeDir, 'projects');
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!isDir(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl')) out.push(join(dir, name));
    }
  }
  return out;
}

export function findCodexLogs(codexDir = defaultCodexDir()): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (isDir(path)) walk(path);
      else if (name.endsWith('.jsonl')) out.push(path);
    }
  };
  const root = join(codexDir, 'sessions');
  if (existsSync(root)) walk(root);
  return out;
}

export function loadSessions(opts: DiscoverOptions = {}): Session[] {
  const sources = opts.sources ?? ['claude', 'codex'];
  const jobs: Array<[string, (f: string) => Session]> = [];
  if (sources.includes('claude')) for (const f of findClaudeLogs(opts.claudeDir)) jobs.push([f, (x) => parseClaudeSession(x)]);
  if (sources.includes('codex')) for (const f of findCodexLogs(opts.codexDir)) jobs.push([f, parseCodexSession]);

  const sessions: Session[] = [];
  for (const [file, parse] of jobs) {
    try {
      const s = parse(file);
      if (!s.messages.some((m) => !m.meta)) continue;
      if (opts.project && !(s.cwd ?? '').toLowerCase().includes(opts.project.toLowerCase())) continue;
      sessions.push(s);
    } catch (err) {
      opts.onError?.(file, err);
    }
  }
  return sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/** Match a session by full id or unique id prefix. */
export function findSession(sessions: Session[], query: string): Session | Session[] | undefined {
  const exact = sessions.find((s) => s.id === query);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.id.startsWith(query));
  if (matches.length === 1) return matches[0];
  return matches.length ? matches : undefined;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
