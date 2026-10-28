import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readJsonl, oneLine, stringify } from './jsonl.js';
import { emptyUsage, type Block, type MessageStatus, type Session } from './types.js';

/**
 * Claude Code writes one JSONL file per session under ~/.claude/projects/<project>/<id>.jsonl.
 * The file is append-only: every entry carries a uuid and a parentUuid, so the file is a tree.
 * The live conversation is the path from the newest entry back to the root. Entries off that
 * path were abandoned by a rewind or edit. A compaction writes a `compact_boundary` entry whose
 * parentUuid is null and whose logicalParentUuid points at the last pre-compaction entry, so
 * everything above the boundary is still on disk, just hidden from the model and the UI.
 */
export function parseClaudeSession(file: string, opts: { sidechain?: boolean } = {}): Session {
  const entries = readJsonl(file).filter((e) => opts.sidechain || !e.isSidechain);
  const id = entries.find((e) => e.sessionId)?.sessionId ?? basename(file, '.jsonl');

  const byId = new Map<string, any>();
  for (const e of entries) if (typeof e.uuid === 'string') byId.set(e.uuid, e);

  // Walk from the newest entry to the root. Crossing a compact boundary flips us into the
  // compacted region; everything from there up was summarized away.
  const onPath = new Map<string, MessageStatus>();
  const tip = [...entries].reverse().find((e) => typeof e.uuid === 'string');
  let compacted = false;
  let cursor = tip;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    onPath.set(cursor.uuid, compacted ? 'compacted' : 'main');
    let parentId = cursor.parentUuid;
    if (isCompactBoundary(cursor)) {
      compacted = true;
      parentId = parentId ?? cursor.logicalParentUuid;
    }
    cursor = parentId ? byId.get(parentId) : undefined;
  }

  // Claude Code writes each content block of one API response as its own entry, all sharing
  // message.id. Treat siblings of an on-path response as on-path too.
  const apiIdStatus = new Map<string, MessageStatus>();
  for (const e of entries) {
    const status = onPath.get(e.uuid);
    if (status && e.type === 'assistant' && e.message?.id) apiIdStatus.set(e.message.id, status);
  }

  const statusOf = (e: any): MessageStatus => {
    const s = onPath.get(e.uuid) ?? (e.type === 'assistant' ? apiIdStatus.get(e.message?.id) : undefined);
    if (s) return s;
    // Entries not reachable at all (no tip) are best treated as live.
    return tip ? 'branch' : 'main';
  };

  const session: Session = {
    id,
    source: 'claude',
    file,
    title: '',
    messages: [],
    compactions: 0,
    branches: 0,
    usage: emptyUsage(),
    subagents: [],
  };

  const tools = new Map<string, Extract<Block, { kind: 'tool' }>>();
  const countedUsage = new Set<string>();
  let titleHint: string | undefined;
  let firstPrompt: string | undefined;

  for (const e of entries) {
    if (e.cwd && !session.cwd) session.cwd = e.cwd;
    if (e.timestamp) {
      session.startedAt ??= e.timestamp;
      session.updatedAt = e.timestamp;
    }
    if (e.type === 'custom-title' && e.customTitle) titleHint = e.customTitle;
    else if (e.type === 'ai-title' && e.aiTitle && !titleHint) titleHint = e.aiTitle;
    else if (e.type === 'summary' && e.summary && !titleHint) titleHint = e.summary;

    if (isCompactBoundary(e)) {
      session.compactions++;
      const trigger = e.compactMetadata?.trigger ? ` (${e.compactMetadata.trigger})` : '';
      session.messages.push({
        id: e.uuid,
        role: 'system',
        timestamp: e.timestamp,
        status: statusOf(e),
        blocks: [{ kind: 'compaction', text: `Conversation compacted${trigger}` }],
      });
      continue;
    }

    if ((e.type !== 'user' && e.type !== 'assistant') || !e.message) continue;
    const status = statusOf(e);
    const parentId = e.parentUuid ?? e.logicalParentUuid;

    if (e.type === 'assistant') {
      const msg = e.message;
      if (msg.model && msg.model !== '<synthetic>') session.model = msg.model;
      if (msg.usage && msg.id && !countedUsage.has(msg.id)) {
        countedUsage.add(msg.id);
        session.usage.inputTokens += msg.usage.input_tokens ?? 0;
        session.usage.outputTokens += msg.usage.output_tokens ?? 0;
        session.usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
        session.usage.cacheWriteTokens += msg.usage.cache_creation_input_tokens ?? 0;
      }
      const blocks = assistantBlocks(msg.content, tools);
      if (!blocks.length) continue;
      const prev = session.messages[session.messages.length - 1];
      // One agent turn (text, tool calls, more tool calls) reads best as one card. Tool results are
      // folded into their tool blocks, so consecutive assistant entries belong to the same turn.
      if (prev && prev.role === 'assistant' && prev.status === status) {
        prev.blocks.push(...blocks);
      } else {
        session.messages.push({ id: e.uuid, parentId, role: 'assistant', timestamp: e.timestamp, status, blocks });
      }
      continue;
    }

    if (e.isCompactSummary) {
      session.messages.push({
        id: e.uuid,
        parentId,
        role: 'system',
        timestamp: e.timestamp,
        status,
        blocks: [{ kind: 'compaction', text: contentText(e.message.content) }],
      });
      continue;
    }

    const { blocks, meta } = userBlocks(e.message.content, tools);
    if (!blocks.length) continue;
    const isMeta = Boolean(e.isMeta) || meta;
    if (!isMeta && !firstPrompt) {
      const text = blocks.find((b) => b.kind === 'text');
      if (text && text.kind === 'text') firstPrompt = text.text;
    }
    session.messages.push({ id: e.uuid, parentId, role: 'user', timestamp: e.timestamp, status, blocks, meta: isMeta || undefined });
  }

  // A branch starts wherever an abandoned message hangs off something still on the live path.
  const statusById = new Map(session.messages.map((m) => [m.id, m.status]));
  session.branches = session.messages.filter((m) => {
    if (m.status !== 'branch' || m.role !== 'user' || m.meta) return false;
    const parent = m.parentId ? statusById.get(m.parentId) ?? onPath.get(m.parentId) : undefined;
    return parent !== 'branch';
  }).length;

  session.title = oneLine(titleHint ?? firstPrompt ?? '(untitled session)');
  if (!opts.sidechain) session.subagents = parseSubagents(file);
  return session;
}

function isCompactBoundary(e: any): boolean {
  return e?.type === 'system' && e.subtype === 'compact_boundary';
}

function assistantBlocks(content: unknown, tools: Map<string, Extract<Block, { kind: 'tool' }>>): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ kind: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const c of content) {
    if (c?.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text });
    else if (c?.type === 'thinking' && c.thinking?.trim()) out.push({ kind: 'thinking', text: c.thinking });
    else if (c?.type === 'tool_use' || c?.type === 'server_tool_use') {
      const block: Extract<Block, { kind: 'tool' }> = { kind: 'tool', id: c.id ?? '', name: c.name ?? 'tool', input: stringify(c.input) };
      if (c.id) tools.set(c.id, block);
      out.push(block);
    }
  }
  return out;
}

const META_PREFIXES = ['<system-reminder>', '<local-command-stdout>', '<local-command-stderr>', '<task-notification>', '<local-command-caveat>'];

function userBlocks(content: unknown, tools: Map<string, Extract<Block, { kind: 'tool' }>>): { blocks: Block[]; meta: boolean } {
  const items = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const blocks: Block[] = [];
  let meta = false;
  for (const c of items) {
    if (c?.type === 'tool_result') {
      const tool = tools.get(c.tool_use_id);
      const output = contentText(c.content);
      if (tool) {
        tool.output = output;
        if (c.is_error) tool.isError = true;
      } else {
        blocks.push({ kind: 'tool', id: c.tool_use_id ?? '', name: 'tool result', input: '', output, isError: c.is_error || undefined });
      }
    } else if (c?.type === 'image') {
      blocks.push({ kind: 'image' });
    } else if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
      const text = c.text.trim();
      const command = slashCommand(text);
      if (command) blocks.push({ kind: 'text', text: command });
      else {
        if (META_PREFIXES.some((p) => text.startsWith(p))) meta = true;
        blocks.push({ kind: 'text', text: c.text });
      }
    }
  }
  return { blocks, meta };
}

/** Claude Code stores "/foo bar" as <command-name>/foo</command-name><command-args>bar</command-args>. */
function slashCommand(text: string): string | undefined {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (!name) return undefined;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  const cmd = name.startsWith('/') ? name : `/${name}`;
  return args ? `${cmd} ${args}` : cmd;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringify(content);
  return content
    .map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : stringify(c)))
    .join('\n');
}

function parseSubagents(file: string): Session[] {
  const dir = join(file.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return [];
  const out: Session[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const sub = parseClaudeSession(path, { sidechain: true });
      sub.id = name.replace(/\.jsonl$/, '');
      const metaPath = path.replace(/\.jsonl$/, '.meta.json');
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (meta.description) sub.title = oneLine(meta.description);
        if (meta.toolUseId) sub.parentToolUseId = meta.toolUseId;
      }
      out.push(sub);
    } catch {
      // a broken subagent log should not hide the parent session
    }
  }
  return out.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
}
