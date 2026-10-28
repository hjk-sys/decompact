import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Block, Message, Session } from './types.js';

const MAX_TOOL_CHARS = 20_000;
const MAX_SEARCH_CHARS = 200_000;

export interface SiteResult {
  dir: string;
  index: string;
  pages: number;
}

export interface SessionSummary {
  key: string;
  title: string;
  project: string;
  cwd: string;
  source: Session['source'];
  started: string;
  updated: string;
  messages: number;
  compacted: number;
  branched: number;
  compactions: number;
  subagents: number;
}

export function pageKey(s: Session, parent?: Session): string {
  const own = `${s.source}-${s.id}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return parent ? `${pageKey(parent)}--${own}` : own;
}

export function summarize(s: Session): SessionSummary {
  const visible = s.messages.filter((m) => !m.meta);
  return {
    key: pageKey(s),
    title: s.title,
    project: s.cwd ? basename(s.cwd) : '',
    cwd: s.cwd ?? '',
    source: s.source,
    started: s.startedAt ?? '',
    updated: s.updatedAt ?? '',
    messages: visible.length,
    compacted: visible.filter((m) => m.status === 'compacted').length,
    branched: visible.filter((m) => m.status === 'branch').length,
    compactions: s.compactions,
    subagents: s.subagents.length,
  };
}

/** Write index.html, one page per session (and subagent), and a lazy-loaded search index. */
export function writeSite(sessions: Session[], dir: string): SiteResult {
  const pagesDir = join(dir, 'sessions');
  mkdirSync(pagesDir, { recursive: true });
  let pages = 0;
  const search: Array<{ k: string; x: string }> = [];

  for (const s of sessions) {
    writeFileSync(join(pagesDir, `${pageKey(s)}.html`), renderSession(s));
    pages++;
    for (const sub of s.subagents) {
      writeFileSync(join(pagesDir, `${pageKey(sub, s)}.html`), renderSession(sub, s));
      pages++;
    }
    search.push({ k: pageKey(s), x: searchText(s) });
  }

  writeFileSync(join(dir, 'search.js'), `window.__decompactSearch = ${safeJson(search)};\n`);
  const index = join(dir, 'index.html');
  writeFileSync(index, renderIndex(sessions.map(summarize)));
  return { dir, index, pages };
}

function searchText(s: Session): string {
  const parts: string[] = [];
  let size = 0;
  for (const m of s.messages) {
    if (m.meta) continue;
    for (const b of m.blocks) {
      if (b.kind !== 'text' && b.kind !== 'compaction') continue;
      parts.push(b.text);
      size += b.text.length;
    }
    if (size > MAX_SEARCH_CHARS) break;
  }
  return parts.join('\n').slice(0, MAX_SEARCH_CHARS);
}

// ---------------------------------------------------------------- session page

export function renderSession(s: Session, parent?: Session): string {
  const sum = summarize(s);
  const subLinks = new Map<string, Session>();
  for (const sub of s.subagents) if (sub.parentToolUseId) subLinks.set(sub.parentToolUseId, sub);

  const facts = [
    s.source === 'claude' ? 'Claude Code' : 'Codex',
    s.cwd && `<span title="${esc(s.cwd)}">${esc(sum.project)}</span>`,
    s.model && esc(s.model),
    s.startedAt && esc(fmtDate(s.startedAt)),
    `${sum.messages} messages`,
    tokens(s),
  ].filter(Boolean);

  const banner: string[] = [];
  if (sum.compacted) {
    banner.push(`<strong>${sum.compacted} messages</strong> were hidden by ${s.compactions || 'a'} compaction${s.compactions === 1 ? '' : 's'}. They're shown here with a <span class="tag compacted">compacted</span> label.`);
  }
  if (sum.branched) {
    banner.push(`<strong>${sum.branched} messages</strong> sit on branches you rewound or edited away. They're shown with a <span class="tag branch">rewound</span> label.`);
  }

  const back = parent
    ? `<a href="${pageKey(parent)}.html">← ${esc(parent.title)}</a>`
    : `<a href="../index.html">← All sessions</a>`;

  const subs = s.subagents.length
    ? `<section class="subs"><h2>Subagents</h2><ul>${s.subagents
        .map((sub) => `<li><a href="${pageKey(sub, s)}.html">${esc(sub.title)}</a> <span class="dim">${summarize(sub).messages} messages</span></li>`)
        .join('')}</ul></section>`
    : '';

  const body = s.messages.map((m) => renderMessage(m, s, subLinks)).join('\n');

  return page(
    s.title,
    `<header class="top">
  <nav>${back}</nav>
  <h1>${esc(s.title)}</h1>
  <p class="facts">${facts.join(' · ')}</p>
  ${banner.length ? `<div class="banner">${banner.map((b) => `<p>${b}</p>`).join('')}</div>` : ''}
  <div class="controls">
    <label><input type="checkbox" data-toggle="hide-compacted"> Hide compacted</label>
    <label><input type="checkbox" data-toggle="hide-branch"> Hide rewound</label>
    <label><input type="checkbox" data-toggle="show-meta"> Show injected context</label>
    <label><input type="checkbox" data-toggle="show-thinking"> Show thinking</label>
    <button type="button" id="expand">Expand all tools</button>
  </div>
</header>
${subs}
<main class="log">
${body}
</main>
<footer>Session <code>${esc(s.id)}</code> · <code>${esc(s.file)}</code><br>Export as Markdown: <code>npx decompact export ${esc(s.id.slice(0, 8))}</code></footer>`,
    SESSION_SCRIPT,
  );
}

function renderMessage(m: Message, s: Session, subLinks: Map<string, Session>): string {
  const who = m.role === 'user' ? (m.meta ? 'Context' : 'You') : m.role === 'assistant' ? 'Agent' : 'System';
  const tag = m.status === 'compacted' ? '<span class="tag compacted">compacted</span>' : m.status === 'branch' ? '<span class="tag branch">rewound</span>' : '';
  const blocks = m.blocks.map((b) => renderBlock(b, s, subLinks)).join('\n');
  const cls = ['msg', m.role, `status-${m.status}`, m.meta ? 'meta' : '', m.blocks.every((b) => b.kind === 'tool') ? 'tools-only' : '']
    .filter(Boolean)
    .join(' ');
  return `<article class="${cls}" id="m-${esc(m.id)}">
  <div class="who">${who}${tag}${m.timestamp ? `<time>${esc(fmtTime(m.timestamp))}</time>` : ''}</div>
  <div class="body">${blocks}</div>
</article>`;
}

function renderBlock(b: Block, s: Session, subLinks: Map<string, Session>): string {
  switch (b.kind) {
    case 'text':
      return `<div class="text">${renderText(b.text)}</div>`;
    case 'thinking':
      return `<details class="thinking"><summary>Thinking</summary><div class="text">${renderText(b.text)}</div></details>`;
    case 'image':
      return '<div class="dim">[image]</div>';
    case 'compaction':
      return `<details class="compaction"><summary>${esc(firstLine(b.text, 'Conversation compacted'))}</summary><div class="text">${renderText(b.text)}</div></details>`;
    case 'tool': {
      const sub = subLinks.get(b.id);
      const link = sub ? `<a class="sublink" href="${pageKey(sub, s)}.html">Open subagent transcript →</a>` : '';
      return `<details class="tool${b.isError ? ' error' : ''}"><summary><span class="name">${esc(b.name)}</span> <span class="hint">${esc(toolHint(b.input))}</span></summary>${
        b.input ? `<pre class="in">${esc(clip(b.input))}</pre>` : ''
      }${b.output !== undefined ? `<pre class="out">${esc(clip(b.output)) || '<span class="dim">(no output)</span>'}</pre>` : ''}${link}</details>`;
    }
  }
}

function toolHint(input: string): string {
  try {
    const v = JSON.parse(input);
    const pick = v.command ?? v.file_path ?? v.path ?? v.pattern ?? v.description ?? v.url ?? v.query ?? v.cmd;
    if (pick) return firstLine(Array.isArray(pick) ? pick.join(' ') : String(pick), '').slice(0, 140);
    const firstString = v && typeof v === 'object' ? Object.values(v).find((x) => typeof x === 'string' && x.trim()) : undefined;
    if (typeof firstString === 'string') return firstLine(firstString, '').slice(0, 140);
    return '';
  } catch {
    // free-form input
  }
  return firstLine(input, '').slice(0, 140);
}

// ---------------------------------------------------------------- index page

function renderIndex(rows: SessionSummary[]): string {
  const totals = rows.reduce(
    (t, r) => ({ compacted: t.compacted + r.compacted, branched: t.branched + r.branched, messages: t.messages + r.messages }),
    { compacted: 0, branched: 0, messages: 0 },
  );
  return page(
    'decompact',
    `<header class="top">
  <h1>decompact</h1>
  <p class="facts">${rows.length} sessions · ${totals.messages.toLocaleString('en-US')} messages · <strong>${totals.compacted.toLocaleString('en-US')}</strong> recovered from compaction · <strong>${totals.branched.toLocaleString('en-US')}</strong> on rewound branches</p>
  <div class="controls">
    <input id="q" type="search" placeholder="Search titles, projects and everything you and the agent said…" autofocus>
    <select id="src"><option value="">All agents</option><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
  </div>
</header>
<main><ul id="list" class="sessions"></ul><p id="empty" class="dim" hidden>No sessions match.</p></main>
<footer>Generated by decompact. Everything stays on this computer.</footer>
<script>window.__decompactRows = ${safeJson(rows)};</script>`,
    INDEX_SCRIPT,
  );
}

// ---------------------------------------------------------------- helpers

function page(title: string, content: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${content}
<script>${script}</script>
</body>
</html>
`;
}

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Small, safe Markdown subset: fenced code, inline code, bold, headings and http links. */
export function renderText(text: string): string {
  return text
    .split(/(```[^\n]*\n[\s\S]*?```)/g)
    .map((part) => {
      const fenced = part.match(/^```[^\n]*\n([\s\S]*?)```$/);
      if (fenced) return `<pre class="code">${esc(fenced[1])}</pre>`;
      return part
        .split(/(`[^`\n]+`)/g)
        .map((seg) => {
          if (/^`[^`\n]+`$/.test(seg)) return `<code>${esc(seg.slice(1, -1))}</code>`;
          return esc(seg)
            .replace(/^(#{1,6}) (.+)$/gm, (_m, _h, t) => `<strong class="h">${t}</strong>`)
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
        })
        .join('');
    })
    .join('');
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function clip(text: string): string {
  return text.length > MAX_TOOL_CHARS ? `${text.slice(0, MAX_TOOL_CHARS)}\n… (${(text.length - MAX_TOOL_CHARS).toLocaleString('en-US')} more characters in the raw log)` : text;
}

function firstLine(text: string, fallback: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? fallback;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tokens(s: Session): string {
  const u = s.usage;
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  if (!total) return '';
  return `<span title="input ${u.inputTokens.toLocaleString('en-US')} · output ${u.outputTokens.toLocaleString('en-US')} · cache read ${u.cacheReadTokens.toLocaleString('en-US')} · cache write ${u.cacheWriteTokens.toLocaleString('en-US')}">${compact(total)} tokens</span>`;
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

const CSS = `
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1d1f;--dim:#6b6b70;--line:#e6e3de;--accent:#3b5bdb;--user:#eef2ff;--code:#f4f2ee;
--compacted:#b45309;--compacted-bg:#fff7ed;--branch:#7c3aed;--branch-bg:#f5f3ff;--err:#c92a2a}
@media (prefers-color-scheme:dark){:root{--bg:#131316;--panel:#1b1b1f;--ink:#ececf1;--dim:#9a9aa3;--line:#2c2c33;--accent:#8ea2ff;--user:#1e2340;--code:#222228;
--compacted:#f59e0b;--compacted-bg:#2a1f10;--branch:#a78bfa;--branch-bg:#221a35;--err:#ff8787}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
.top,main,footer,.subs{max-width:920px;margin:0 auto;padding:0 16px}
.top{padding-top:28px}
.top nav{font-size:14px;margin-bottom:6px}
h1{font-size:24px;line-height:1.3;margin:0 0 6px}
.facts{color:var(--dim);margin:0 0 14px;font-size:14px}
.banner{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:4px 14px;margin-bottom:14px;font-size:14px}
.controls{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:10px 0 16px;border-bottom:1px solid var(--line);font-size:14px;position:sticky;top:0;background:var(--bg);z-index:2}
.controls input[type=search]{flex:1 1 320px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit}
.controls select,.controls button{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font:inherit;cursor:pointer}
.log{padding-top:12px;padding-bottom:40px}
.msg{margin:10px 0;padding:10px 14px;border-radius:10px;background:var(--panel);border:1px solid var(--line)}
.msg.user{background:var(--user)}
.msg.meta{opacity:.75}
.msg.tools-only{padding:6px 14px}
.msg.status-compacted{border-left:4px solid var(--compacted);background:var(--compacted-bg)}
.msg.status-branch{border-left:4px solid var(--branch);background:var(--branch-bg)}
.who{font-size:12px;font-weight:600;color:var(--dim);display:flex;gap:8px;align-items:center;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em}
.who time{font-weight:400;margin-left:auto}
.tag{font-size:11px;padding:1px 7px;border-radius:99px;text-transform:none;letter-spacing:0;font-weight:600}
.tag.compacted{color:var(--compacted);border:1px solid var(--compacted)}
.tag.branch{color:var(--branch);border:1px solid var(--branch)}
.text{white-space:pre-wrap;overflow-wrap:anywhere}
.text code{background:var(--code);padding:1px 4px;border-radius:4px}
.text .h{display:inline-block;margin-top:4px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--code);padding:10px;border-radius:8px;margin:6px 0;max-height:520px;overflow:auto}
details{margin:4px 0}
summary{cursor:pointer;font-size:13px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool .name{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--ink);font-weight:600}
.tool.error .name{color:var(--err)}
.tool pre.out{border-left:3px solid var(--line)}
.compaction{border:1px dashed var(--compacted);border-radius:8px;padding:6px 10px}
.compaction summary{color:var(--compacted);font-weight:600}
.thinking{display:none}
body.show-thinking .thinking{display:block}
body:not(.show-meta) .msg.meta{display:none}
body.hide-compacted .status-compacted{display:none}
body.hide-branch .status-branch{display:none}
.sublink{display:inline-block;margin:4px 0 2px;font-size:13px}
.subs h2{font-size:15px;margin:14px 0 4px}
.subs ul{margin:0;padding-left:18px;font-size:14px}
.dim{color:var(--dim)}
footer{color:var(--dim);font-size:12px;padding-bottom:40px;overflow-wrap:anywhere}
.sessions{list-style:none;padding:0;margin:12px 0}
.sessions li{border-bottom:1px solid var(--line)}
.sessions a{display:block;padding:12px 4px;text-decoration:none;color:var(--ink)}
.sessions a:hover{background:var(--panel)}
.sessions .t{font-weight:600}
.sessions .m{font-size:13px;color:var(--dim);margin-top:2px;display:flex;flex-wrap:wrap;gap:4px 12px}
.sessions .snip{font-size:13px;color:var(--dim);margin-top:4px}
.sessions mark{background:#fde68a;color:#1d1d1f;border-radius:3px}
`;

const SESSION_SCRIPT = `
(function(){
  var KEY='decompact:view';
  var saved={};try{saved=JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){}
  document.querySelectorAll('[data-toggle]').forEach(function(box){
    var cls=box.getAttribute('data-toggle');
    box.checked=!!saved[cls];
    document.body.classList.toggle(cls,box.checked);
    box.addEventListener('change',function(){
      document.body.classList.toggle(cls,box.checked);
      saved[cls]=box.checked;try{localStorage.setItem(KEY,JSON.stringify(saved))}catch(e){}
    });
  });
  var open=false;
  document.getElementById('expand').addEventListener('click',function(){
    open=!open;
    document.querySelectorAll('details.tool').forEach(function(d){d.open=open});
    this.textContent=open?'Collapse all tools':'Expand all tools';
  });
})();
`;

const INDEX_SCRIPT = `
(function(){
  var rows=window.__decompactRows||[];
  var list=document.getElementById('list'),empty=document.getElementById('empty');
  var q=document.getElementById('q'),src=document.getElementById('src');
  var text=null,loading=false;
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function date(s){var d=new Date(s);return isNaN(d)?'':d.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
  function loadText(){
    if(text||loading)return;loading=true;
    var s=document.createElement('script');s.src='search.js';
    s.onload=function(){text={};(window.__decompactSearch||[]).forEach(function(e){text[e.k]=e.x});render()};
    document.head.appendChild(s);
  }
  function snippet(body,terms){
    var lower=body.toLowerCase(),i=lower.indexOf(terms[0]);if(i<0)return'';
    var start=Math.max(0,i-80),chunk=body.slice(start,i+160).replace(/\\s+/g,' ');
    var out=esc(chunk);
    terms.forEach(function(t){if(!t)return;out=out.replace(new RegExp(t.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&'),'gi'),function(m){return '<mark>'+m+'</mark>'})});
    return (start?'…':'')+out+'…';
  }
  function render(){
    var terms=q.value.toLowerCase().split(/\\s+/).filter(Boolean),only=src.value,html=[],n=0;
    if(terms.length)loadText();
    rows.forEach(function(r){
      if(only&&r.source!==only)return;
      var hay=(r.title+' '+r.cwd).toLowerCase(),body=text&&text[r.key]||'',lb=body.toLowerCase();
      if(terms.length&&!terms.every(function(t){return hay.indexOf(t)>=0||lb.indexOf(t)>=0}))return;
      n++;if(n>500)return;
      var bits=[r.source==='claude'?'Claude Code':'Codex',esc(r.project),date(r.updated),r.messages+' messages'];
      if(r.compactions)bits.push('<span class="tag compacted">'+r.compacted+' compacted</span>');
      if(r.branched)bits.push('<span class="tag branch">'+r.branched+' rewound</span>');
      if(r.subagents)bits.push(r.subagents+' subagents');
      var snip=terms.length&&body?snippet(body,terms):'';
      html.push('<li><a href="sessions/'+encodeURIComponent(r.key)+'.html"><div class="t">'+esc(r.title)+'</div><div class="m">'+bits.filter(Boolean).join('<span>·</span>')+'</div>'+(snip?'<div class="snip">'+snip+'</div>':'')+'</a></li>');
    });
    list.innerHTML=html.join('');empty.hidden=n>0;
  }
  q.addEventListener('input',render);src.addEventListener('change',render);
  render();
})();
`;
