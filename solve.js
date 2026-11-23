// A faster drop-in for makefun-site 1.0.0. Byte-identical output, faster hot paths.
// Reimplements the vendor pipeline (front matter, Markdown subset, template dialect,
// slug rule, report) with the same rules; only the mechanics are faster.

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;
const ESC_RE_G = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast: String.replace (native) beats a char loop ~2.4x. */
export function escapeHtml(text) {
  return ESC_RE.test(text) ? text.replace(ESC_RE_G, (c) => ESCAPES[c]) : text;
}

export const SLUG_MAX = 64;

/** The slug of `text` (NFKD, combining marks dropped, runs of non [a-z0-9] one "-", cut to 64). */
export function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  let plain = text;
  if (/[^\x00-\x7F]/.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  if (cache !== undefined) cache.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace (same set as \s). */
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS[c] = 1;
for (let c = 8192; c <= 8202; c++) WS[c] = 1;
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)]) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. `text` has "\n" line ends. */
export function parseFrontMatter(text) {
  if (!(text === '---' || text.startsWith('---\n'))) return { error: 'no front matter' };
  // Scan the front-matter lines (few) without splitting the whole text; the body is sliced.
  const fm = [];
  let pos = 4;
  let closePos = -1;
  while (true) {
    if (pos > text.length) return { error: 'the front matter is not closed' };
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (line === '---') {
      closePos = nl === -1 ? text.length : nl + 1;
      break;
    }
    fm.push(line);
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
  }
  const data = {};
  for (let k = 0; k < fm.length; k++) {
    const line = fm[k];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closePos) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return BLANK.test(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}

const trimLine = (line) => {
  if (line === '') return line;
  const c0 = line.charCodeAt(0);
  const c1 = line.charCodeAt(line.length - 1);
  if (c0 !== 32 && c0 !== 9 && c1 !== 32 && c1 !== 9) return line;
  return line.replace(/^[ \t]+|[ \t]+$/g, '');
};

/** `src` rendered: its HTML, its table of contents and its excerpt.
 * Fused lex + render: one pass over the lines (no split array, no token
 * objects), HTML built directly. Lines are classified by first character. */
function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  // Line iterator with 1-line pushback; yields the same lines as src.split('\n').
  let p = 0;
  const N = src.length;
  let finished = false;
  let peeked = null;
  let hasPeek = false;
  const nextLine = () => {
    if (finished) return null;
    const nl = src.indexOf('\n', p);
    if (nl === -1) {
      const s = src.slice(p);
      finished = true;
      return s;
    }
    const s = src.slice(p, nl);
    p = nl + 1;
    return s;
  };
  const peek = () => {
    if (hasPeek) return peeked;
    peeked = nextLine();
    hasPeek = true;
    return peeked;
  };
  const take = () => {
    if (hasPeek) {
      hasPeek = false;
      const l = peeked;
      peeked = null;
      return l;
    }
    return nextLine();
  };
  while (true) {
    const line = take();
    if (line === null) break;
    if (line === '') continue;
    const c0 = line.charCodeAt(0);
    let handled = false;
    if (c0 === 32 || c0 === 9) {
      if (BLANK.test(line)) handled = true;
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        while (true) {
          const nx = peek();
          if (nx === null) break;
          if (FENCE_CLOSE.test(nx)) { take(); break; }
          body.push(take());
        }
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        out.push(`<pre><code${cls}>${body.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
        handled = true;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const html = inline(heading.text, env);
        out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        handled = true;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        out.push('<hr>');
        handled = true;
      } else {
        const bullet = BULLET.exec(line);
        if (bullet !== null) {
          const items = [[trimLine(bullet[1])]];
          while (true) {
            const nx = peek();
            if (nx === null) break;
            const m = BULLET.exec(nx);
            if (m !== null) { take(); items.push([trimLine(m[1])]); }
            else if (CONTINUED.test(nx)) { take(); items[items.length - 1].push(trimLine(nx)); }
            else break;
          }
          out.push(`<ul>\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</ul>`);
          handled = true;
        }
      }
    } else if (c0 === 62) {
      const body = [line.charCodeAt(1) === 32 ? line.slice(2) : line.slice(1)];
      while (true) {
        const nx = peek();
        if (nx === null || !QUOTE.test(nx)) break;
        take();
        body.push(nx.charCodeAt(1) === 32 ? nx.slice(2) : nx.slice(1));
      }
      const ls = body.map(trimLine).filter((l) => l !== '');
      out.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(ls.join('\n'), env)}</p>\n</blockquote>`);
      handled = true;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [[trimLine(ordered[2])]];
        while (true) {
          const nx = peek();
          if (nx === null) break;
          const m = ORDERED.exec(nx);
          if (m !== null) { take(); items.push([trimLine(m[2])]); }
          else if (CONTINUED.test(nx)) { take(); items[items.length - 1].push(trimLine(nx)); }
          else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        out.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</ol>`);
        handled = true;
      }
    }
    if (!handled) {
      const parts = [trimLine(line)];
      while (true) {
        const nx = peek();
        if (nx === null || endsParagraph(nx)) break;
        take();
        parts.push(trimLine(nx));
      }
      const html = inline(parts.join('\n'), env);
      if (excerpt === null) excerpt = html;
      out.push(`<p>${html}</p>`);
    }
  }
  return { html: out.length === 0 ? '' : `${out.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

/** The characters a backslash escapes, as a charCode lookup. */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** One regex drives inline rendering: it finds every char that is either a
 * construct opener (\ ` * [) or an HTML special char (& < > " '). Text between
 * two matches holds neither, so it needs no escaping and is pushed as-is. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  INLINE_RE.lastIndex = 0;
  let m = INLINE_RE.exec(s);
  if (m === null) return s;
  const out = [];
  let i = 0;
  while (m !== null) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const code = s.charCodeAt(j);
    if (code === 38) { out.push('&amp;'); i = j + 1; }
    else if (code === 60) { out.push('&lt;'); i = j + 1; }
    else if (code === 62) { out.push('&gt;'); i = j + 1; }
    else if (code === 34) { out.push('&quot;'); i = j + 1; }
    else if (code === 39) { out.push('&#39;'); i = j + 1; }
    else if (code === 92) { // backslash
      if (j + 1 < s.length && s.charCodeAt(j + 1) < 128 && ESCAPABLE[s.charCodeAt(j + 1)]) {
        out.push(ESCAPES[s[j + 1]] ?? s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (code === 96) { // backtick
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (code === 42) { // *
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>', inline(s.slice(j + 2, k), env), '</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>', inline(s.slice(j + 1, k), env), '</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else { // [
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(j + 1, k), env), '</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    }
    INLINE_RE.lastIndex = i;
    m = INLINE_RE.exec(s);
  }
  if (i < s.length) out.push(s.slice(i));
  return out.join('');
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The root variables that are the same for every render in a build. */
const STATIC_ROOTS = new Set(['site', 'tags', 'recent']);

/**
 * The root variables template `name` depends on, with loop variables resolved through
 * `bindings` (loop var -> root vars of its collection). A template whose set is a subset
 * of STATIC_ROOTS renders the same string for every page in the build, so its output can
 * be cached. Cycles are guarded: a re-entered template reports a '__cycle__' root, which
 * is never static, so a cyclic template is never cached.
 */
function templateDeps(templates, name, bindings, memo, visiting) {
  const key = `${name}|${[...bindings.entries()].map(([k, v]) => `${k}=${[...v].sort().join(',')}`).join(';')}`;
  if (memo.has(key)) return memo.get(key);
  if (visiting.has(name)) return new Set(['__cycle__']);
  const nodes = templates.get(name);
  const deps = new Set();
  memo.set(key, deps);
  if (nodes === undefined) return deps;
  visiting.add(name);
  const addPath = (path, b) => {
    const root = path[0];
    if (b.has(root)) {
      for (const d of b.get(root)) deps.add(d);
    } else {
      deps.add(root);
    }
  };
  const walk = (ns, b) => {
    for (const n of ns) {
      if (n.kind === 'text') continue;
      if (n.kind === 'var' || n.kind === 'raw') addPath(n.path, b);
      else if (n.kind === 'if') {
        addPath(n.path, b);
        walk(n.then, b);
        if (n.else) walk(n.else, b);
      } else if (n.kind === 'for') {
        addPath(n.path, b);
        const inner = new Map(b);
        const coll = new Set();
        const root = n.path[0];
        if (b.has(root)) {
          for (const d of b.get(root)) coll.add(d);
        } else {
          coll.add(root);
        }
        inner.set(n.name, coll);
        // `loop` (index/first/last/length) is bound by the for too, to the same collection.
        inner.set('loop', coll);
        walk(n.body, inner);
      } else if (n.kind === 'include') {
        for (const d of templateDeps(templates, n.name, b, memo, visiting)) deps.add(d);
      }
    }
  };
  walk(nodes, bindings);
  visiting.delete(name);
  return deps;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One child scope per for-node, its vars mutated per iteration: the body is
        // rendered synchronously, so nothing holds the scope past its iteration.
        const childVars = {};
        const child = { vars: childVars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          childVars[n.name] = xs[k];
          childVars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) {
          if (ctx.staticTemplates !== undefined && ctx.staticTemplates.has(n.name)) {
            // Static: same string for every render in this build; cache it per depth.
            const key = `${n.name}@${depth + 1}`;
            let s = ctx.staticCache.get(key);
            if (s === undefined) {
              const tmp = [];
              renderNodes(t, scope, ctx, depth + 1, tmp);
              s = tmp.join('');
              ctx.staticCache.set(key, s);
            }
            out.push(s);
          } else {
            renderNodes(t, scope, ctx, depth + 1, out);
          }
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Templates that depend only on build-level data (site/tags/recent) render the same
  // string for every page; their output is cached per build in renderNodes.
  const staticTemplates = new Set();
  {
    const memo = new Map();
    for (const name of templates.keys()) {
      const deps = templateDeps(templates, name, new Map(), memo, new Set());
      let isStatic = true;
      for (const d of deps) {
        if (!STATIC_ROOTS.has(d)) {
          isStatic = false;
          break;
        }
      }
      if (isStatic) staticTemplates.add(name);
    }
  }
  const slugCache = new Map();
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache,
  };

  // 1. Sources, in code-unit order of path; .md is a source, the rest static.
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) {
        const c = f.content;
        b.sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
      } else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Front matter; a refused source or a draft is reported and dropped.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Markdown, links resolved.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slugCache);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: posts newest first, then by slug.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. Tags.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name, slugCache);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name, slugCache);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (s.post) continue;
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, slugCache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  function cardOf(s) {
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  function pageOf(s) {
    return {
      // A post's card is already built (b.cards, step 7 start); reuse it instead of rebuilding it.
      ...(s.post ? b.cards.get(s) : cardOf(s)),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // 7. Layouts.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const ctx = { templates: b.templates, escape: escapeHtml, staticTemplates, staticCache: new Map() };
    // One shared build scope (site/tags/recent); each render's own vars hang off it
    // as a child scope, so no per-render spread of the build-level vars.
    const buildScope = { vars: { site, tags: allTags, recent }, parent: null };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderNodes(nodes, { vars, parent: buildScope }, ctx, 0, out);
      return out.join('');
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

/** The entrypoint: makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  return build(input);
}
