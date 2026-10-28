export type Source = 'claude' | 'codex';

/**
 * Where a message sits relative to the conversation as it stands now.
 * - main:      part of the live context the agent currently sees
 * - compacted: still on disk, but summarized away by a compaction
 * - branch:    on a path that was abandoned by a rewind, edit or retry
 */
export type MessageStatus = 'main' | 'compacted' | 'branch';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: string; output?: string; isError?: boolean }
  | { kind: 'image' }
  | { kind: 'compaction'; text: string };

export interface Message {
  id: string;
  parentId?: string;
  role: 'user' | 'assistant' | 'system';
  timestamp?: string;
  blocks: Block[];
  status: MessageStatus;
  /** Injected context the user did not type: system reminders, skill bodies, environment blobs. */
  meta?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Session {
  id: string;
  source: Source;
  file: string;
  title: string;
  cwd?: string;
  model?: string;
  startedAt?: string;
  updatedAt?: string;
  messages: Message[];
  compactions: number;
  branches: number;
  usage: Usage;
  subagents: Session[];
  /** For a subagent: the tool call in the parent session that started it. */
  parentToolUseId?: string;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
