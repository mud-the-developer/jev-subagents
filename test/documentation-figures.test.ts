import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const file = (name: string) => new URL(`../docs/figures/${name}`, import.meta.url);

test('historical Goal figures retain editable sources and accessible local references, not current README feature advertising', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const archive = await readFile(file('README.md'), 'utf8');
  assert.doesNotMatch(readme, /!\[[^\]]*\]\(docs\/figures\/(?:workflow|scope)\.png\)/);
  assert.match(archive, /역사 자료/);
  for (const name of ['workflow', 'scope']) {
    const source = JSON.parse(await readFile(file(`${name}.excalimate.json`), 'utf8'));
    assert.equal(source.version, '2.0.0');
    const ids = source.scene.elements.map((element: { id: string }) => element.id);
    assert.equal(new Set(ids).size, ids.length);
    const validation = JSON.parse(await readFile(file(`${name}.validation.json`), 'utf8'));
    assert.match(validation.validation.content[0].text, /^Project is valid V2:/);
    assert.match(archive, new RegExp(`!\\[[^\\]]{25,}\\]\\(${name}\\.png\\)`));
    const text = source.scene.elements.filter((element: { type: string }) => element.type === 'text').map((element: { text: string }) => element.text).join('\n');
    if (name === 'workflow') {
      for (const label of ['사용자 승인', 'worker 하나만', '추천 ≠ 실행 권한', '거절 · 취소 → 중단', '단일 Goal은 미검증 종료']) assert.ok(text.includes(label), label);
    } else for (const label of ['일반 위임', '파일 한정 Goal', '지정한 기존 파일 ID만', 'bash · 탐색 · 새 파일 생성 불가', '정상 종료도 미검증', 'OS sandbox 아님']) assert.ok(text.includes(label), label);
  }
});

test('README figure assets are bounded static SVG/retina PNG with no scripts, embedded HTML, remote links or clipped Korean labels', async () => {
  const report = JSON.parse(await readFile(file('export-report.json'), 'utf8'));
  assert.equal(report.localOnly, true); assert.equal(report.externalBrowserRequestsAllowed, false);
  for (const name of ['workflow', 'scope']) {
    const svg = await readFile(file(`${name}.svg`), 'utf8');
    assert.ok(Buffer.byteLength(svg) < 65536); assert.match(svg, /^<svg\b/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|animate\w*|set)\b/i);
    assert.doesNotMatch(svg, /\bon\w+\s*=/i);
    assert.doesNotMatch(svg, /(?:href\s*=\s*["'](?:https?:|\/\/)|url\s*\()/i);
    const png = await readFile(file(`${name}.png`));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), 2240); assert.equal(png.readUInt32BE(20), 1260); assert.ok(png.length < 300000);
    const rendered = report.reports.find((item: { name: string }) => item.name === name);
    assert.deepEqual(rendered.geometry.clipped, []); assert.equal(rendered.geometry.width, 1120); assert.equal(rendered.geometry.height, 630);
    assert.ok(rendered.geometry.textCount >= 15);
  }
});
