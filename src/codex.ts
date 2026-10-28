import { basename } from 'node:path';
import { readJsonl, oneLine, stringify } from './jsonl.js';
import { emptyUsage, type Block, type Message, type Session } from './types.js';

/**
 * Codex CLI writes ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. Each line is
 * { timestamp, type, payload } where type is session_meta, response_item, event_msg,
 * turn_context or compacted. Older rollouts have no wrapper: the first line is the session
 * meta and the rest are bare response items. A `compacted` line replaces the model's history,
 * so everything logged before it is marked compacted.
 */
export function parseCodexSession(file: string): Session {
  const lines = readJsonl(file);
  const session: Session = {
    id: basename(file, '.jsonl').replace(/^rollout-/, ''),
    source: 'codex',
    file,
    title: '',
    messages: [],
    compactions: 0,
    branches: 0,
    usage: emptyUsage(),
    subagents: [],
  };

  const tools = new Map<string, Extract<Block, { kind: 'tool' }>>();
  let firstPrompt: string | undefined;
  let n = 0;

  const push = (role: Message['role'], blocks: Block[], timestamp?: string, meta?: boolean) => {
    const prev = session.messages[session.messages.length - 1];
    if (prev && prev.role === role && role === 'assistant' && !prev.meta && !meta) {
      prev.blocks.push(...blocks);
      return;
    }
    session.messages.push({ id: `${session.id}:${n++}`, role, timestamp, status: 'main', blocks, meta: meta || undefined });
  };

  for (const line of lines) {
    const wrapped = line && typeof line === 'object' && 'payload' in line;
    const type: string | undefined = wrapped ? line.type : undefined;
    const p = wrapped ? line.payload : line;
    const ts: string | undefined = line.timestamp ?? p?.timestamp;
    if (ts) {
      session.startedAt ??= ts;
      session.updatedAt = ts;
    }

    if (type === 'session_meta' || (!wrapped && p?.id && p?.instructions !== undefined && !p.type)) {
      if (p.id) session.id = p.id;
      if (p.cwd) session.cwd = p.cwd;
      continue;
    }
    if (type === 'turn_context') {
      if (p?.model) session.model = p.model;
      if (p?.cwd && !session.cwd) session.cwd = p.cwd;
      continue;
    }
    if (type === 'compacted') {
      session.compactions++;
      for (const m of session.messages) m.status = 'compacted';
      const text = typeof p?.message === 'string' && p.message.trim() ? p.message : 'Conversation compacted';
      push('system', [{ kind: 'compaction', text }], ts);
      continue;
    }
    if (type === 'event_msg') {
      if (p?.type === 'token_count' && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        session.usage = {
          inputTokens: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cached_input_tokens ?? 0,
          cacheWriteTokens: 0,
        };
      }
      continue;
    }
    if (wrapped && type !== 'response_item') continue;
    if (!p || typeof p !== 'object') continue;

    switch (p.type) {
      case 'message': {
        const text = (Array.isArray(p.content) ? p.content : [])
          .map((c: any) => (typeof c?.text === 'string' ? c.text : c?.type === 'input_image' ? '[image]' : ''))
          .filter(Boolean)
          .join('\n');
        if (!text.trim()) break;
        if (p.role === 'assistant') {
          push('assistant', [{ kind: 'text', text }], ts);
        } else {
          const meta = p.role !== 'user' || isInjected(text);
          if (!meta && !firstPrompt) firstPrompt = text;
          push(p.role === 'user' ? 'user' : 'system', [{ kind: 'text', text }], ts, meta);
        }
        break;
      }
      case 'reasoning': {
        const text = [...(p.summary ?? []), ...(p.content ?? [])]
          .map((s: any) => s?.text ?? '')
          .filter(Boolean)
          .join('\n\n');
        if (text.trim()) push('assistant', [{ kind: 'thinking', text }], ts);
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const input = p.type === 'function_call' ? prettyArgs(p.arguments) : p.type === 'custom_tool_call' ? stringify(p.input) : stringify(p.action);
        const block: Extract<Block, { kind: 'tool' }> = { kind: 'tool', id: p.call_id ?? p.id ?? '', name: p.name ?? 'shell', input };
        if (block.id) tools.set(block.id, block);
        push('assistant', [block], ts);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const output = typeof p.output === 'string' ? unwrapOutput(p.output) : stringify(p.output?.content ?? p.output);
        const tool = tools.get(p.call_id);
        if (tool) tool.output = output;
        else push('assistant', [{ kind: 'tool', id: p.call_id ?? '', name: 'tool result', input: '', output }], ts);
        break;
      }
    }
  }

  session.title = oneLine(firstPrompt ?? '(untitled session)');
  return session;
}

function isInjected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<environment_context>') || t.startsWith('<user_instructions>') || t.startsWith('# AGENTS.md') || t.startsWith('<turn_aborted>');
}

function prettyArgs(args: unknown): string {
  if (typeof args !== 'string') return stringify(args);
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/** Codex often wraps tool output as a JSON string {"output": "...", "metadata": {...}}. */
function unwrapOutput(raw: string): string {
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.output === 'string') return parsed.output;
  } catch {
    // not JSON
  }
  return raw;
}
