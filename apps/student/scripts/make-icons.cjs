// 仮のアイコン（花丸）を作る（PW-02）。教室のロゴができたら public/icons の PNG を差し替える。
//   NODE_PATH=$(npm root -g) node scripts/make-icons.cjs public/icons
const { chromium } = require('playwright');
const petals = 12;
const R = 180, r = 150;
let d = '';
for (let i = 0; i < petals; i++) {
  const a0 = (i / petals) * 2 * Math.PI, a1 = ((i + 1) / petals) * 2 * Math.PI, am = (a0 + a1) / 2;
  const p = (a, rr) => `${(256 + rr * Math.cos(a)).toFixed(1)} ${(256 + rr * Math.sin(a)).toFixed(1)}`;
  d += (i === 0 ? `M ${p(a0, r)} ` : '') + `Q ${p(am, R + 40)} ${p(a1, r)} `;
}
const spiral = [];
for (let t = 0; t <= 4.2 * Math.PI; t += 0.1) {
  const rr = 20 + t * 8.5;
  spiral.push(`${(256 + rr * Math.cos(t - Math.PI / 2)).toFixed(1)} ${(256 + rr * Math.sin(t - Math.PI / 2)).toFixed(1)}`);
}
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${512 + 2 * pad} ${512 + 2 * pad}" width="512" height="512">
<rect x="${-pad}" y="${-pad}" width="${512 + 2 * pad}" height="${512 + 2 * pad}" fill="#fff"/>
<path d="${d}Z" fill="none" stroke="#111" stroke-width="16" stroke-linejoin="round"/>
<polyline points="${spiral.join(' ')}" fill="none" stroke="#111" stroke-width="16" stroke-linecap="round"/></svg>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const out = process.argv[2];
  for (const [name, size, pad] of [['icon-512', 512, 20], ['icon-192', 192, 20], ['apple-touch-icon', 180, 40], ['icon-maskable-512', 512, 110]]) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg(pad)).toString('base64')}" width="${size}" height="${size}">`);
    await p.screenshot({ path: `${out}/${name}.png` });
  }
  await b.close();
})();
