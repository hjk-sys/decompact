import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions, parseClaudeSession, parseCodexSession, redactSecrets, renderSession, shareSession, toMarkdown, writeSite } from '../dist/index.js';
import { makeHomes } from './fixtures.js';

const homes = makeHomes();
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const byText = (s, text) => s.messages.find((m) => m.blocks.some((b) => 'text' in b && b.text.includes(text)));

test('claude: live path, rewound branch and compacted region are told apart', () => {
  const s = parseClaudeSession(homes.claudeFile);
  assert.equal(s.title, 'Parser in TypeScript');
  assert.equal(s.cwd, '/work/demo');
  assert.equal(s.model, 'claude-test');
  assert.equal(s.compactions, 1);
  assert.equal(s.branches, 1);

  assert.equal(byText(s, 'Build a parser').status, 'compacted');
  assert.equal(byText(s, 'Use TypeScript instead').status, 'compacted');
  assert.equal(byText(s, 'Actually write it in Rust').status, 'branch');
  assert.equal(byText(s, 'Rewriting in Rust').status, 'branch');
  assert.equal(byText(s, 'Tests added').status, 'main');
  assert.equal(byText(s, 'be nice').meta, true);
  assert.ok(byText(s, '/test all'), 'slash command is shown as typed');
});

test('claude: one response split across entries plus its tool result reads as one turn', () => {
  const s = parseClaudeSession(homes.claudeFile);
  const turn = byText(s, 'Sure, starting');
  const tool = turn.blocks.find((b) => b.kind === 'tool');
  assert.equal(tool.name, 'Bash');
  assert.equal(tool.output, 'file.txt');
  assert.ok(turn.blocks.some((b) => b.kind === 'text' && b.text === 'Found one file.'));
  // usage is counted once per API response, not once per entry
  assert.equal(s.usage.outputTokens, 5 * 5);
});

test('claude: compaction summary and subagents are kept', () => {
  const s = parseClaudeSession(homes.claudeFile);
  const summary = s.messages.find((m) => m.blocks.some((b) => b.kind === 'compaction' && b.text.includes('Summary: parser')));
  assert.equal(summary.status, 'main');
  assert.equal(s.subagents.length, 1);
  assert.equal(s.subagents[0].title, 'Research docs');
  assert.equal(s.subagents[0].parentToolUseId, 't1');
});

test('codex: rollout items, tool output and compaction', () => {
  const s = parseCodexSession(homes.codexFile);
  assert.equal(s.id, 'codex-abc');
  assert.equal(s.title, 'Fix the flaky test');
  assert.equal(s.model, 'gpt-test');
  assert.equal(s.compactions, 1);
  assert.equal(byText(s, 'Fix the flaky test').status, 'compacted');
  assert.equal(byText(s, 'All green').status, 'main');
  assert.equal(byText(s, '<environment_context>').meta, true);
  const tool = s.messages.flatMap((m) => m.blocks).find((b) => b.kind === 'tool');
  assert.equal(tool.output, '1 failing');
  assert.match(tool.input, /"npm"/);
  assert.equal(s.usage.cacheReadTokens, 300);
});

test('markdown: compacted kept, branches and meta left out by default', () => {
  const md = toMarkdown(parseClaudeSession(homes.claudeFile));
  assert.match(md, /^# Parser in TypeScript/);
  assert.match(md, /Build a parser/);
  assert.match(md, /_\(compacted\)_/);
  assert.doesNotMatch(md, /Rust/);
  assert.doesNotMatch(md, /be nice/);
  assert.match(toMarkdown(parseClaudeSession(homes.claudeFile), { branches: true }), /Rewriting in Rust/);
  assert.doesNotMatch(toMarkdown(parseClaudeSession(homes.claudeFile), { compacted: false }), /Build a parser/);
});

test('html: content is escaped and statuses are labeled', () => {
  const html = renderSession(parseClaudeSession(homes.claudeFile));
  assert.match(html, /Build a parser for &lt;logs&gt;/);
  assert.doesNotMatch(html, /<logs>/);
  assert.match(html, /status-compacted/);
  assert.match(html, /status-branch/);
  assert.match(html, /Open subagent transcript/);
});

test('discovery and site output', () => {
  const sessions = loadSessions({ claudeDir: homes.claudeDir, codexDir: homes.codexDir });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].source, 'codex', 'newest first');
  const site = writeSite(sessions, join(homes.root, 'site'));
  assert.ok(existsSync(site.index));
  assert.equal(site.pages, 3);
  assert.match(readFileSync(join(homes.root, 'site', 'search.js'), 'utf8'), /Fix the flaky test/);
  assert.equal(loadSessions({ claudeDir: homes.claudeDir, codexDir: homes.codexDir, project: 'codex-demo' }).length, 1);
});

test('cli: list, export and build', () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: homes.claudeDir, CODEX_HOME: homes.codexDir };
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  assert.match(run('list'), /Parser in TypeScript/);
  assert.match(run('export', '1111', '--branches'), /Rewriting in Rust/);
  const out = run('--no-open', '--out', join(homes.root, 'cli-site'));
  assert.match(out, /2 sessions/);
  assert.ok(existsSync(join(homes.root, 'cli-site', 'index.html')));
});

test('share: one standalone file with secrets and home path redacted', () => {
  const s = parseClaudeSession(homes.claudeFile);
  const home = homedir();
  const key = 'ghp_' + 'a'.repeat(36);
  const first = s.messages.find((m) => m.blocks.some((b) => b.kind === 'text'));
  const block = first.blocks.find((b) => b.kind === 'text');
  block.text += ` token ${key} in ${home}/code and AWS AKIAABCDEFGHIJKLMNOP and DB_PASSWORD=hunter2hunter2`;
  const { html, redactions } = shareSession(s);
  assert.doesNotMatch(html, new RegExp(key));
  assert.doesNotMatch(html, /AKIAABCDEFGHIJKLMNOP/);
  assert.doesNotMatch(html, /hunter2hunter2/);
  assert.match(html, /\[REDACTED GitHub token\]/);
  assert.match(html, /~\/code/);
  assert.equal(redactions['GitHub token'], 1);
  assert.match(html, /Made with <a href="https:\/\/github.com\/hjk-sys\/agentlog">decompact/);
  assert.doesNotMatch(html, /All sessions|Open subagent transcript|be nice/);
  assert.doesNotMatch(html, /Rewriting in Rust/);
  assert.match(shareSession(s, { branches: true }).html, /Rewriting in Rust/);
  assert.doesNotMatch(shareSession(s, { tools: false }).html, /class="tool/);
  assert.equal(redactSecrets('nothing to see here'), 'nothing to see here');
});

test('cli: latest, compacted-only and share', () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: homes.claudeDir, CODEX_HOME: homes.codexDir };
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(run('export', 'latest', '--project', 'demo', '--source', 'claude'), /Parser in TypeScript/);
  const hidden = run('export', '1111', '--compacted-only');
  assert.match(hidden, /Build a parser/);
  assert.doesNotMatch(hidden, /Tests added/);
  const file = join(homes.root, 'shared.html');
  run('share', '1111', '--no-open', '-o', file);
  assert.match(readFileSync(file, 'utf8'), /Made with/);
});
