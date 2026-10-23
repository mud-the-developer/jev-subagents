import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const upstream = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || 'docs/figures');
if (!process.argv[2]) throw new Error('Usage: node scripts/figures/create-excalimate-projects.mjs <built-excalimate-checkout> [output-dir]');
const { Client } = await import(pathToFileURL(path.join(upstream, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(path.join(upstream, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href);
const client = new Client({ name: 'jev-readme-figures', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(upstream, 'mcp-server/dist/index.js'), '--stdio'], stderr: 'pipe' });
const color = { ink: '#1e293b', muted: '#475569', line: '#64748b', blue: '#1d4ed8', blueBg: '#eff6ff', gold: '#a16207', goldBg: '#fef3c7', teal: '#0f766e', tealBg: '#f0fdfa', red: '#b91c1c', redBg: '#fff1f2', white: '#f8fafc' };
let seed = 100;
function shape(id, x, y, width, height, strokeColor, backgroundColor, extra = {}) {
  return { id, type: 'rectangle', x, y, width, height, strokeColor, backgroundColor, fillStyle: 'solid', strokeWidth: 2, roughness: 0.4, seed: seed++, roundness: { type: 3 }, ...extra };
}
function text(id, x, y, width, value, size = 24, ink = color.ink, align = 'left') {
  return { id, type: 'text', x, y, width, height: size * 1.4 * value.split('\n').length, text: value, originalText: value, fontSize: size,
    fontFamily: 5, textAlign: align, verticalAlign: 'top', lineHeight: 1.4, strokeColor: ink, seed: seed++, roughness: 0.4 };
}
function arrow(id, x, y, dx, dy, dashed = false) {
  return { id, type: 'arrow', x, y, width: Math.abs(dx), height: Math.abs(dy), points: [[0, 0], [dx, dy]],
    strokeColor: color.line, strokeWidth: 2, roughness: 0.4, strokeStyle: dashed ? 'dashed' : 'solid', endArrowhead: 'arrow', seed: seed++ };
}
function canvas() { return shape('canvas', 0, 0, 1120, 630, color.white, color.white, { roundness: null, roughness: 0 }); }
function workflow() {
  const nodes = [
    ['request', '작업 요청', '무엇을 · 어디까지', color.blue, color.blueBg],
    ['choose', '모델 선택', '고정 worker / 후보', color.blue, color.blueBg],
    ['approve', '사용자 승인', '모델 · 도구 · 범위', color.gold, color.goldBg],
    ['execute', '작업 실행', 'worker 하나만', color.teal, color.tealBg],
    ['review', '결과 검토', '선택적 검사 + 사람', color.blue, color.blueBg],
  ];
  const elements = [canvas(), text('title', 32, 32, 1056, '01  승인한 범위만 맡깁니다', 34),
    text('subtitle', 32, 84, 1056, '누가 고르고, 누가 승인하고, 누가 실행하는가', 24, color.muted),
    shape('jev', 242, 148, 210, 90, color.blue, color.blueBg, { strokeStyle: 'dashed' }),
    text('jev-title', 252, 159, 190, 'JEV 조언 (선택)', 25, color.blue, 'center'),
    text('jev-note', 250, 196, 194, '추천 ≠ 실행 권한', 21, color.muted, 'center'), arrow('jev-to-choice', 347, 240, 0, 39, true)];
  nodes.forEach(([id, title, label, stroke, fill], index) => {
    const x = 32 + index * 224;
    elements.push(shape(id, x, 286, 184, 122, stroke, fill), text(`${id}-title`, x + 4, 311, 176, title, 28, color.ink, 'center'),
      text(`${id}-note`, x + 4, 357, 176, label, 19, color.muted, 'center'));
    if (index < 4) elements.push(arrow(`flow-${index}`, x + 189, 347, 30, 0));
  });
  elements.push(arrow('stop-branch', 572, 412, 0, 29, true), shape('stop', 475, 447, 194, 62, color.red, color.redBg),
    text('stop-label', 480, 465, 184, '거절 · 취소 → 중단', 21, color.red, 'center'),
    text('foot-one', 32, 539, 1056, '검증을 추가해도 마지막 수락은 사람의 몫입니다.', 24, color.ink, 'center'),
    text('foot-two', 32, 578, 1056, '단일 Goal은 미검증 종료 · JEV 평가용 증거 전송은 별도 승인', 20, color.muted, 'center'));
  return elements;
}
function scope() {
  return [canvas(), text('title', 32, 32, 1056, '02  작업 범위를 고르세요', 34),
    text('subtitle', 32, 84, 1056, '넓은 도구가 필요한가, 정해진 기존 파일만 다루면 되는가?', 24, color.muted),
    shape('delegate', 32, 145, 512, 390, color.blue, color.blueBg), shape('goal', 576, 145, 512, 390, color.teal, color.tealBg),
    text('delegate-title', 61, 171, 453, '일반 위임', 32, color.blue), text('delegate-tool', 61, 219, 453, 'jev_delegate', 22, color.muted),
    text('goal-title', 604, 171, 454, '파일 한정 Goal', 32, color.teal), text('goal-tool', 604, 219, 454, 'jev_goal', 22, color.muted),
    text('delegate-use', 61, 277, 453, '조사 · 작은 수정 · 테스트', 27), text('goal-use', 604, 277, 454, '지정한 기존 파일 ID만', 27),
    text('delegate-tools', 61, 334, 453, '승인한 프로필의 도구 사용', 24), text('goal-tools', 604, 334, 454, 'read / edit / write', 26),
    text('delegate-limit', 61, 380, 453, 'bash 가능 · OS sandbox 아님', 23, color.muted),
    text('goal-limit', 604, 380, 454, 'bash · 탐색 · 새 파일 생성 불가', 23, color.red),
    text('delegate-check', 61, 443, 453, '검증 명령은 선택 사항', 24), text('goal-check', 604, 443, 454, '정상 종료도 미검증', 24),
    text('delegate-assess', 61, 482, 453, 'JEV 평가: 별도 증거 전송 승인', 20, color.muted), text('goal-settle', 604, 482, 454, '파일 변경과 원장 정산 보고', 20, color.muted),
    text('common', 32, 566, 1056, '두 경로 모두 실행 승인 필수 · 취소해도 변경은 남을 수 있습니다', 23, color.ink, 'center')];
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result;
}
await fs.mkdir(output, { recursive: true });
await client.connect(transport);
try {
  for (const [name, title, elements] of [['workflow', 'JEV 승인 중심 실행 흐름', workflow()], ['scope', '일반 위임과 파일 한정 Goal', scope()]]) {
    await call('clear_scene', {});
    await call('create_scene', { elements });
    await call('set_camera_frame', { x: 560, y: 315, width: 1120, aspectRatio: '16:9' });
    await call('set_clip_range', { start: 0, end: 1000 });
    const validation = await call('validate_project', {});
    const checkpointId = `jev-readme-${name}-v1`;
    await call('save_checkpoint', { id: checkpointId });
    const source = JSON.parse(await fs.readFile(path.join(os.tmpdir(), 'excalimate-mcp-checkpoints', `${checkpointId}.json`), 'utf8'));
    source.metadata.name = title;
    await fs.writeFile(path.join(output, `${name}.excalimate.json`), `${JSON.stringify(source, null, 2)}\n`);
    await fs.writeFile(path.join(output, `${name}.validation.json`), `${JSON.stringify({ name, validation }, null, 2)}\n`);
    console.log(JSON.stringify({ name, elements: elements.length, checkpointId, validation: validation.content }));
  }
} finally { await client.close(); }
