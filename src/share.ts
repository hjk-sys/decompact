import { homedir } from 'node:os';
import { renderSession } from './render.js';
import type { Block, Message, Session } from './types.js';

export interface ShareOptions {
  /** Include messages that a compaction summarized away (default true). */
  compacted?: boolean;
  /** Include messages on abandoned branches (default false). */
  branches?: boolean;
  /** Include thinking blocks (default false). */
  thinking?: boolean;
  /** Include tool calls and their output (default true). */
  tools?: boolean;
  /** Replace secrets and the home folder path (default true). */
  redact?: boolean;
}

export interface ShareResult {
  html: string;
  /** How many secrets were replaced, by kind. */
  redactions: Record<string, number>;
}

// Common credential shapes. Each match is replaced with [REDACTED <kind>].
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['URL password', /(?<=[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi],
  ['bearer token', /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g],
  ['secret', /(?<=\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[=:]\s*["']?)[^\s"'`,;]{8,}/gi],
];

/** Replace common secret shapes in text. Counts what it replaced into `counts`. */
export function redactSecrets(text: string, counts: Record<string, number> = {}): string {
  let out = text;
  for (const [kind, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m) => (m.startsWith('[REDACTED') ? m : ((counts[kind] = (counts[kind] ?? 0) + 1), `[REDACTED ${kind}]`)));
  }
  return out;
}

/** Render one session as a single self-contained HTML file that is safe-ish to send to someone. */
export function shareSession(session: Session, opts: ShareOptions = {}): ShareResult {
  const o = { compacted: true, branches: false, thinking: false, tools: true, redact: true, ...opts };
  const counts: Record<string, number> = {};
  const home = homedir();
  const clean = (text: string): string => {
    if (!o.redact) return text;
    let t = redactSecrets(text, counts);
    if (home && home.length > 1) t = t.split(home).join('~');
    return t;
  };

  const messages: Message[] = [];
  for (const m of session.messages) {
    if (m.meta) continue;
    if (m.status === 'compacted' && !o.compacted) continue;
    if (m.status === 'branch' && !o.branches) continue;
    const blocks = m.blocks.filter((b) => (b.kind !== 'thinking' || o.thinking) && (b.kind !== 'tool' || o.tools)).map((b) => cleanBlock(b, clean));
    if (blocks.length) messages.push({ ...m, blocks });
  }

  const shared: Session = {
    ...session,
    title: clean(session.title),
    cwd: session.cwd && clean(session.cwd),
    file: '',
    messages,
    subagents: [],
  };
  return { html: renderSession(shared, undefined, { share: true }), redactions: counts };
}

function cleanBlock(b: Block, clean: (t: string) => string): Block {
  switch (b.kind) {
    case 'text':
    case 'thinking':
    case 'compaction':
      return { ...b, text: clean(b.text) };
    case 'tool':
      return { ...b, input: clean(b.input), output: b.output === undefined ? undefined : clean(b.output) };
    default:
      return b;
  }
}
