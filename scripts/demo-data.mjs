// Writes made-up Claude Code and Codex sessions for the README demo.
// Usage: node scripts/demo-data.mjs <dir>   →   <dir>/claude and <dir>/codex
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/demo-data.mjs <dir>');

const day = (d, h, m) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

function claudeSession({ id, cwd, title, turns }) {
  const rows = [];
  let parent = null;
  let n = 0;
  const base = (t) => ({ uuid: `${id}-${n++}`, sessionId: id, cwd, timestamp: t, isSidechain: false });
  const usage = { input_tokens: 1200, output_tokens: 420, cache_read_input_tokens: 38000, cache_creation_input_tokens: 2100 };
  const marks = {};
  for (const turn of turns) {
    if (turn.mark) {
      marks[turn.mark] = parent;
      continue;
    }
    if (turn.rewindTo) {
      parent = marks[turn.rewindTo];
      continue;
    }
    if (turn.compact) {
      const b = { ...base(turn.t), type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: parent, compactMetadata: { trigger: 'auto' } };
      rows.push(b);
      const s = { ...base(turn.t), type: 'user', parentUuid: b.uuid, isCompactSummary: true, message: { role: 'user', content: turn.compact } };
      rows.push(s);
      parent = s.uuid;
      continue;
    }
    if (turn.user) {
      const u = { ...base(turn.t), type: 'user', parentUuid: parent, message: { role: 'user', content: turn.user } };
      rows.push(u);
      parent = u.uuid;
      continue;
    }
    const apiId = `msg_${id}_${n}`;
    for (const block of turn.blocks) {
      const toolId = `tu_${n}`;
      const content = block.text
        ? [{ type: 'text', text: block.text }]
        : [{ type: 'tool_use', id: toolId, name: block.tool, input: block.input }];
      const a = { ...base(turn.t), type: 'assistant', parentUuid: parent, message: { id: apiId, role: 'assistant', model: 'claude-opus-5-5', content, usage } };
      rows.push(a);
      parent = a.uuid;
      if (block.tool) {
        const r = {
          ...base(turn.t),
          type: 'user',
          parentUuid: parent,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: block.output ?? '' }] },
        };
        rows.push(r);
        parent = r.uuid;
      }
    }
  }
  rows.push({ type: 'ai-title', aiTitle: title, sessionId: id });
  const dir = join(out, 'claude', 'projects', cwd.replace(/\//g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), jsonl(rows));
}

claudeSession({
  id: '7c2e91d4-58a3-4f0e-9b1a-2d6c8e4f1a07',
  cwd: '/Users/sam/code/payments-api',
  title: 'Migrate webhooks to the new Stripe event format',
  turns: [
    { t: day(26, 14, 2), user: 'Our Stripe webhook handler breaks on the new thin events. Migrate src/webhooks to the v2 event format and keep the old one working until we cut over.' },
    { t: day(26, 14, 3), blocks: [
      { text: "I'll start by reading the current handler and its tests." },
      { tool: 'Read', input: { file_path: 'src/webhooks/stripe.ts' }, output: "export async function handleStripe(req: Request) {\n  const event = stripe.webhooks.constructEvent(req.body, sig, secret);\n  switch (event.type) {\n    case 'invoice.paid': return markPaid(event.data.object);\n    case 'customer.subscription.deleted': return cancel(event.data.object);\n  }\n}" },
      { tool: 'Bash', input: { command: 'npm test -- webhooks', description: 'Run webhook tests' }, output: 'PASS  test/webhooks/stripe.test.ts (14 tests)' },
      { text: 'The handler reads `event.data.object` directly. Thin events only carry an id, so we need to fetch the object first. Plan:\n\n1. Add a `resolveEvent()` that handles both formats\n2. Route on `event.type` exactly as before\n3. Add tests with recorded thin-event payloads' },
    ] },
    { t: day(26, 14, 9), user: 'Sounds right. Keep the retry logic from billing/retry.ts.' },
    { t: day(26, 14, 10), blocks: [
      { tool: 'Edit', input: { file_path: 'src/webhooks/resolve.ts' }, output: 'Created src/webhooks/resolve.ts (+41 lines)' },
      { tool: 'Edit', input: { file_path: 'src/webhooks/stripe.ts' }, output: 'Updated src/webhooks/stripe.ts (+12 −6)' },
      { tool: 'Bash', input: { command: 'npm test -- webhooks', description: 'Run webhook tests' }, output: 'FAIL  test/webhooks/stripe.test.ts\n  ✕ retries on 5xx from the events API (31 ms)\n\nExpected 3 attempts, received 1' },
      { text: "One failure: the retry wrapper isn't applied around the new `events.retrieve` call. Fixing that." },
      { tool: 'Edit', input: { file_path: 'src/webhooks/resolve.ts' }, output: 'Updated src/webhooks/resolve.ts (+3 −1)' },
      { tool: 'Bash', input: { command: 'npm test -- webhooks', description: 'Run webhook tests' }, output: 'PASS  test/webhooks/stripe.test.ts (17 tests)' },
      { text: 'All 17 webhook tests pass, including 3 new ones for thin events.' },
    ] },
    { mark: 'before-flag' },
    { t: day(26, 14, 22), user: 'Now delete the old format handling entirely.' },
    { t: day(26, 14, 23), blocks: [
      { tool: 'Edit', input: { file_path: 'src/webhooks/resolve.ts' }, output: 'Updated src/webhooks/resolve.ts (+0 −18)' },
      { text: 'Removed the snapshot-event branch. Anything still sending v1 payloads will now be rejected with a 400.' },
    ] },
    { rewindTo: 'before-flag' },
    { t: day(26, 14, 25), user: "Actually, don't delete it yet. Put the old path behind a STRIPE_LEGACY_EVENTS flag so we can flip it per environment." },
    { t: day(26, 14, 26), blocks: [
      { tool: 'Edit', input: { file_path: 'src/config.ts' }, output: 'Updated src/config.ts (+4)' },
      { tool: 'Edit', input: { file_path: 'src/webhooks/resolve.ts' }, output: 'Updated src/webhooks/resolve.ts (+6 −2)' },
      { text: 'Done. `STRIPE_LEGACY_EVENTS=true` keeps v1 payloads working. It defaults to `true` in staging and `false` in production.' },
    ] },
    { t: day(26, 15, 40), compact: 'This session is being continued from a previous conversation that ran out of context. Summary:\n- Migrated src/webhooks to Stripe thin events via resolveEvent() with retries from billing/retry.ts\n- Legacy v1 events are behind STRIPE_LEGACY_EVENTS (staging true, prod false)\n- 17 webhook tests pass' },
    { t: day(26, 15, 41), user: 'Why did we keep the legacy path again? I want to remove it.' },
    { t: day(26, 15, 41), blocks: [
      { text: 'From the summary I only know it sits behind `STRIPE_LEGACY_EVENTS`. The reasoning behind keeping it was compacted away.' },
    ] },
  ],
});

claudeSession({
  id: '3f8a0b62-1c47-4d95-a3e2-7b5d9c0e6f18',
  cwd: '/Users/sam/code/web',
  title: 'Fix flaky checkout e2e test',
  turns: [
    { t: day(27, 9, 12), user: 'The checkout e2e test fails about one run in five on CI. Find out why.' },
    { t: day(27, 9, 13), blocks: [
      { tool: 'Bash', input: { command: 'npx playwright test checkout --repeat-each 20', description: 'Repeat checkout test' }, output: '4 failed, 16 passed\n  TimeoutError: locator.click: Timeout 5000ms exceeded waiting for getByRole("button", { name: "Pay" })' },
      { text: 'The Pay button is disabled until the address autocomplete settles. The test clicks before that. Waiting on the `aria-disabled` change instead of a timeout fixes it.' },
    ] },
  ],
});

claudeSession({
  id: 'a91d47c3-6e2b-4f80-8d15-c3b7e0f29a64',
  cwd: '/Users/sam/code/infra',
  title: 'Add Postgres read replica to Terraform',
  turns: [
    { t: day(25, 16, 30), user: 'Add a read replica for the main Postgres instance in terraform/db.tf.' },
    { t: day(25, 16, 31), blocks: [{ text: 'Added `aws_db_instance.main_replica` with `replicate_source_db` set to the primary.' }] },
  ],
});

// One Codex rollout so the source filter has something to show.
const codexDir = join(out, 'codex', 'sessions', '2026', '10', '24');
mkdirSync(codexDir, { recursive: true });
const ts = (m) => day(24, 11, m);
writeFileSync(
  join(codexDir, 'rollout-2026-10-24T11-00-00-5d1e8a20.jsonl'),
  jsonl([
    { timestamp: ts(0), type: 'session_meta', payload: { id: '5d1e8a20-codex', cwd: '/Users/sam/code/cli' } },
    { timestamp: ts(0), type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/Users/sam/code/cli' } },
    { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add shell completions for zsh and fish' }] } },
    { timestamp: ts(2), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added a `completions` subcommand that prints zsh and fish scripts.' }] } },
  ]),
);
