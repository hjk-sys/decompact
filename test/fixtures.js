import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION = '11111111-2222-3333-4444-555555555555';
const at = (n) => `2026-10-01T10:${String(n).padStart(2, '0')}:00.000Z`;
const base = (uuid, parentUuid, n) => ({ uuid, parentUuid, sessionId: SESSION, cwd: '/work/demo', timestamp: at(n), isSidechain: false });
const user = (uuid, parent, n, content, extra = {}) => ({ ...base(uuid, parent, n), type: 'user', message: { role: 'user', content }, ...extra });
const asst = (uuid, parent, n, id, content, usage) => ({
  ...base(uuid, parent, n),
  type: 'assistant',
  message: { id, role: 'assistant', model: 'claude-test', content, usage },
});

/**
 * A session that was rewound once and then compacted:
 *   u1 → a1/a2 (one response) → tool result → a3 ─┬─ u2 → a4         (rewound away)
 *                                                 └─ u3 → a5 ⇢ compact boundary → summary → reminder → u5 → a6
 */
export function claudeEntries() {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
  return [
    user('u1', null, 1, 'Build a parser for <logs>'),
    asst('a1', 'u1', 2, 'm1', [{ type: 'text', text: 'Sure, starting with `jsonl`.' }], usage),
    asst('a2', 'a1', 3, 'm1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }], usage),
    user('r1', 'a2', 4, [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }]),
    asst('a3', 'r1', 5, 'm2', [{ type: 'text', text: 'Found one file.' }], usage),
    user('u2', 'a3', 6, 'Actually write it in Rust'),
    asst('a4', 'u2', 7, 'm3', [{ type: 'text', text: 'Rewriting in Rust.' }], usage),
    user('u3', 'a3', 8, 'Use TypeScript instead'),
    asst('a5', 'u3', 9, 'm4', [{ type: 'thinking', thinking: 'TS it is.' }, { type: 'text', text: 'OK, TypeScript.' }], usage),
    { ...base('b1', null, 10), type: 'system', subtype: 'compact_boundary', logicalParentUuid: 'a5', compactMetadata: { trigger: 'auto' } },
    user('s1', 'b1', 11, 'This session is being continued. Summary: parser in TypeScript.', { isCompactSummary: true }),
    user('u4', 's1', 12, '<system-reminder>be nice</system-reminder>', { isMeta: true }),
    user('u5', 'u4', 13, '<command-name>/test</command-name><command-args>all</command-args>'),
    asst('a6', 'u5', 14, 'm5', [{ type: 'text', text: 'Tests added.' }], usage),
    { type: 'ai-title', aiTitle: 'Parser in TypeScript', sessionId: SESSION },
  ];
}

export function codexLines() {
  const ts = (n) => `2026-10-02T09:${String(n).padStart(2, '0')}:00.000Z`;
  const item = (n, payload) => ({ timestamp: ts(n), type: 'response_item', payload });
  return [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'codex-abc', cwd: '/work/codex-demo', timestamp: ts(0) } },
    { timestamp: ts(0), type: 'turn_context', payload: { model: 'gpt-test', cwd: '/work/codex-demo' } },
    item(1, { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }),
    item(2, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the flaky test' }] }),
    item(3, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Look at the test first.' }] }),
    item(4, { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}', call_id: 'c1' }),
    item(5, { type: 'function_call_output', call_id: 'c1', output: '{"output":"1 failing","metadata":{"exit_code":1}}' }),
    item(6, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The timeout is too short.' }] }),
    { timestamp: ts(7), type: 'compacted', payload: { message: 'Summary: raised the timeout.' } },
    item(8, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now run it again' }] }),
    item(9, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All green.' }] }),
    { timestamp: ts(10), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 40 } } } },
  ];
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** Lay out fake ~/.claude and ~/.codex folders and return their paths. */
export function makeHomes() {
  const root = mkdtempSync(join(tmpdir(), 'agentlog-test-'));
  const claudeDir = join(root, 'claude');
  const project = join(claudeDir, 'projects', '-work-demo');
  mkdirSync(project, { recursive: true });
  const claudeFile = join(project, `${SESSION}.jsonl`);
  // a truncated final line must not break parsing
  writeFileSync(claudeFile, toJsonl(claudeEntries()) + '{"type":"user","mess');

  const subDir = join(project, SESSION, 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    join(subDir, 'agent-x1.jsonl'),
    toJsonl([
      { ...user('s-u1', null, 20, 'Look up the docs'), isSidechain: true },
      { ...asst('s-a1', 's-u1', 21, 'sm1', [{ type: 'text', text: 'Docs say yes.' }]), isSidechain: true },
    ]),
  );
  writeFileSync(join(subDir, 'agent-x1.meta.json'), JSON.stringify({ description: 'Research docs', toolUseId: 't1' }));

  const codexDir = join(root, 'codex');
  const day = join(codexDir, 'sessions', '2026', '10', '02');
  mkdirSync(day, { recursive: true });
  const codexFile = join(day, 'rollout-2026-10-02T09-00-00-codex-abc.jsonl');
  writeFileSync(codexFile, toJsonl(codexLines()));

  return { root, claudeDir, codexDir, claudeFile, codexFile, sessionId: SESSION };
}
