// 特商法の表記・プライバシーポリシー・利用規約の公開ページを、docs/legal/*.md から作る。
//   node apps/top/build-legal.mjs
// Markdown の「<!-- 公開ここから -->」より後だけを公開する（内部メモは出さない）。
// 使える書き方: 見出し（# ## ###）、段落、箇条書き（- ）、番号付き（1. ）、表（| |）、太字（**）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, '../../docs/legal');
const MARK = '<!-- 公開ここから -->';

const PAGES = [
  { src: 'tokushoho.md', out: 'tokushoho.html', path: '/tokushoho' },
  { src: 'privacy.md', out: 'privacy.html', path: '/privacy' },
  { src: 'terms.md', out: 'terms.html', path: '/terms' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 【 】は松田さんが埋める所。公開前に残っていると分かるように印を付ける
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/【([^】]*)】/g, '<mark class="ph">【$1】</mark>');

function toHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{2,3}) (.+)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.slice(1, -1).split('|').map((c) => c.trim());
      const [head, , ...body] = rows;
      out.push('<div class="table-wrap"><table>');
      out.push(`<thead><tr>${cells(head).map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead>`);
      out.push('<tbody>');
      for (const r of body) {
        const [first, ...rest] = cells(r);
        out.push(`<tr><th scope="row">${inline(first)}</th>${rest.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      out.push('</tbody></table></div>');
      continue;
    }
    if (/^- /.test(line) || /^\d+\. /.test(line)) {
      const ordered = /^\d+\. /.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\d+\. /.test(lines[i]) : /^- /.test(lines[i]))) {
        items.push(lines[i++].replace(ordered ? /^\d+\. / : /^- /, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||- |\d+\. )/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(''))}</p>`);
  }
  return out.join('\n');
}

export const header = `<header class="site-header">
  <div class="inner">
    <a class="brand" href="/">${logo()}<span>はなまる音楽教室</span></a>
    <nav class="header-nav" aria-label="ログイン">
      <a class="btn btn-ghost" href="https://staff.hanamarumusic.com/login">講師</a>
      <a class="btn btn-primary" href="https://student.hanamarumusic.com/">生徒ログイン</a>
    </nav>
  </div>
</header>`;

export const footer = `<footer class="site-footer">
  <div class="inner">
    <nav aria-label="教室について">
      <ul class="footer-links">
        <li><a href="/tokushoho">特定商取引法に基づく表記</a></li>
        <li><a href="/privacy">プライバシーポリシー</a></li>
        <li><a href="/terms">利用規約</a></li>
      </ul>
    </nav>
    <p class="copyright">© はなまる音楽教室</p>
  </div>
</footer>`;

export function logo() {
  return `<svg width="28" height="28" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M24 4.5c2 0 3 2.6 4.8 3.2 1.9.6 4.2-.9 5.8.3 1.6 1.2.9 3.9 2 5.5 1.2 1.6 4 1.8 4.6 3.7.6 1.9-1.6 3.6-1.6 5.6s2.2 3.7 1.6 5.6c-.6 1.9-3.4 2.1-4.6 3.7-1.1 1.6-.4 4.3-2 5.5-1.6 1.2-3.9-.3-5.8.3-1.8.6-2.8 3.2-4.8 3.2s-3-2.6-4.8-3.2c-1.9-.6-4.2.9-5.8-.3-1.6-1.2-.9-3.9-2-5.5-1.2-1.6-4-1.8-4.6-3.7-.6-1.9 1.6-3.6 1.6-5.6s-2.2-3.7-1.6-5.6c.6-1.9 3.4-2.1 4.6-3.7 1.1-1.6.4-4.3 2-5.5 1.6-1.2 3.9.3 5.8-.3C21 7.1 22 4.5 24 4.5z" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linejoin="round"/><path d="M24 16.5a7.5 7.5 0 1 0 7.5 7.5c0-3.3-2.7-5-5-5s-4 1.6-4 3.8 1.5 3.2 3 3.2" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"/></svg>`;
}

// このファイルを直接実行したときだけ作る（index.html の作成で上下の帯だけを使うこともあるため）
if (process.argv[1] === fileURLToPath(import.meta.url)) for (const p of PAGES) {
  const md = readFileSync(join(docs, p.src), 'utf8');
  const title = /^# (.+)$/m.exec(md)[1];
  const at = md.indexOf(MARK);
  if (at < 0) throw new Error(`${p.src} に「${MARK}」がありません`);
  const body = toHtml(md.slice(at + MARK.length));
  const html = `<!doctype html>
<!-- このファイルは build-legal.mjs が docs/legal/${p.src} から作る。直接は直さない -->
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff">
<title>${esc(title)}｜はなまる音楽教室</title>
<link rel="icon" href="/favicon.png">
<link rel="stylesheet" href="/site.css">
</head>
<body>
${header}
<main class="doc inner">
<h1>${esc(title)}</h1>
${body}
</main>
${footer}
</body>
</html>
`;
  writeFileSync(join(here, p.out), html);
  console.log(`${p.out} を作りました`);
}
