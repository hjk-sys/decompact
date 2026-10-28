import type { Block, Message, Session } from './types.js';

export interface MarkdownOptions {
  /** Include messages that a compaction summarized away (default true). */
  compacted?: boolean;
  /** Include messages on abandoned branches (default false). */
  branches?: boolean;
  /** Include injected context such as system reminders (default false). */
  meta?: boolean;
  /** Include thinking blocks (default false). */
  thinking?: boolean;
  /** Include tool calls and their output (default true). */
  tools?: boolean;
}

const MAX_TOOL_CHARS = 4000;

export function toMarkdown(session: Session, opts: MarkdownOptions = {}): string {
  const o = { compacted: true, branches: false, meta: false, thinking: false, tools: true, ...opts };
  const lines: string[] = [`# ${session.title}`, ''];
  const facts = [
    `- **Source:** ${session.source === 'claude' ? 'Claude Code' : 'Codex'}`,
    `- **Session:** \`${session.id}\``,
    session.cwd && `- **Project:** \`${session.cwd}\``,
    session.model && `- **Model:** ${session.model}`,
    session.startedAt && `- **Started:** ${session.startedAt}`,
    session.compactions ? `- **Compactions:** ${session.compactions}` : '',
  ].filter(Boolean) as string[];
  lines.push(...facts, '');

  for (const m of session.messages) {
    if (m.status === 'compacted' && !o.compacted) continue;
    if (m.status === 'branch' && !o.branches) continue;
    if (m.meta && !o.meta) continue;
    const body = m.blocks.map((b) => blockMarkdown(b, o)).filter(Boolean).join('\n\n');
    if (!body) continue;
    lines.push(`## ${heading(m)}`, '', body, '');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function heading(m: Message): string {
  const who = m.role === 'user' ? (m.meta ? 'Context' : 'User') : m.role === 'assistant' ? 'Assistant' : 'System';
  const tag = m.status === 'compacted' ? ' _(compacted)_' : m.status === 'branch' ? ' _(rewound branch)_' : '';
  return who + tag;
}

function blockMarkdown(b: Block, o: Required<MarkdownOptions>): string {
  switch (b.kind) {
    case 'text':
      return b.text.trim();
    case 'thinking':
      return o.thinking ? b.text.trim().split('\n').map((l) => `> ${l}`).join('\n') : '';
    case 'image':
      return '_[image]_';
    case 'compaction':
      return `---\n\n**Compaction summary**\n\n${b.text.trim()}\n\n---`;
    case 'tool': {
      if (!o.tools) return '';
      const parts = [`**Tool: ${b.name}**${b.isError ? ' _(error)_' : ''}`];
      if (b.input) parts.push(fence(clip(b.input)));
      if (b.output) parts.push('Output:', fence(clip(b.output)));
      return parts.join('\n\n');
    }
  }
}

function clip(text: string): string {
  return text.length > MAX_TOOL_CHARS ? `${text.slice(0, MAX_TOOL_CHARS)}\n… (${text.length - MAX_TOOL_CHARS} more characters)` : text;
}

function fence(text: string): string {
  const ticks = text.includes('```') ? '````' : '```';
  return `${ticks}\n${text}\n${ticks}`;
}
