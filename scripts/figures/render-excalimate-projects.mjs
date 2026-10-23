import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const upstream = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || 'docs/figures');
const chrome = process.argv[4] || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!process.argv[2]) throw new Error('Usage: node scripts/figures/render-excalimate-projects.mjs <built-excalimate-checkout> [output-dir] [chrome-path]');
const { build } = await import(pathToFileURL(path.join(upstream, 'node_modules/esbuild/lib/main.js')).href);
const { chromium } = await import(pathToFileURL(path.join(upstream, 'node_modules/playwright-core/index.mjs')).href);
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-excalimate-render-'));
const entry = `
import { generatePlayerPackage } from ${JSON.stringify(path.join(upstream, 'src/services/playerPackage.ts'))};
import { compileAnimatedSvg } from '@excalimate/export-runtime';
import { parseProjectDocument } from '@excalimate/project-schema';
window.renderProject = async (raw) => {
  const project = parseProjectDocument(raw);
  const player = await generatePlayerPackage(project, []);
  const compiled = compileAnimatedSvg(player, { profile: 'css-keyframes', theme: 'light' });
  const doc = new DOMParser().parseFromString(compiled.svg, 'image/svg+xml');
  doc.querySelectorAll('style,animate,animateTransform,animateMotion,set').forEach(node => node.remove());
  doc.querySelectorAll('text').forEach(node => node.setAttribute('font-family', 'Malgun Gothic, Segoe UI, sans-serif'));
  const svg = new XMLSerializer().serializeToString(doc.documentElement);
  return { svg, compiler: { profile: compiled.profile, posterTimeMs: compiled.posterTimeMs,
    sourceKeyframeCount: compiled.sourceKeyframeCount, emittedKeyframeCount: compiled.emittedKeyframeCount },
    sourceElements: project.scene.elements.length };
};`;
await build({ stdin: { contents: entry, resolveDir: upstream, sourcefile: 'jev-figures.ts', loader: 'ts' }, bundle: true, platform: 'browser',
  format: 'esm', outfile: path.join(work, 'bundle.js'), logLevel: 'warning', minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, assetNames: 'asset-[hash]' });
const fontRoot = path.join(upstream, 'node_modules/@excalidraw/excalidraw/dist/prod');
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="ko"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>body{margin:0;background:#f8fafc}#figure{width:1120px;height:630px}#figure>svg{display:block;width:1120px;height:630px}</style><div id="figure"></div><script>window.EXCALIDRAW_ASSET_PATH="/excalidraw/"</script><script type="module" src="/bundle.js"></script></html>'); return;
    }
    const root = pathname.startsWith('/excalidraw/') ? fontRoot : work;
    const relative = pathname.startsWith('/excalidraw/') ? pathname.slice('/excalidraw/'.length) : pathname.slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) { response.writeHead(403).end(); return; }
    const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[path.extname(file)] || 'application/octet-stream';
    response.setHeader('content-type', mime); response.end(await fs.readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 630 }, deviceScaleFactor: 2 });
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.waitForFunction(() => typeof window.renderProject === 'function');
  const reports = [];
  for (const name of ['workflow', 'scope']) {
    const project = JSON.parse(await fs.readFile(path.join(output, `${name}.excalimate.json`), 'utf8'));
    const rendered = await page.evaluate(raw => window.renderProject(raw), project);
    if (/<(?:script|foreignObject|animate\w*|set)\b/i.test(rendered.svg) || /\bon\w+\s*=/i.test(rendered.svg) ||
      /(?:href\s*=\s*["'](?:https?:|\/\/)|url\s*\()/i.test(rendered.svg)) throw new Error(`Unsafe SVG export: ${name}`);
    await fs.writeFile(path.join(output, `${name}.svg`), `${rendered.svg}\n`);
    const geometry = await page.evaluate(async svg => {
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
      if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('Invalid sanitized SVG');
      document.querySelector('#figure').replaceChildren(document.importNode(parsed.documentElement, true));
      await document.fonts.ready;
      const root = document.querySelector('#figure > svg').getBoundingClientRect();
      const clipped = [...document.querySelectorAll('#figure text')].filter(node => { const box = node.getBoundingClientRect();
        return box.left < root.left - 1 || box.right > root.right + 1 || box.top < root.top - 1 || box.bottom > root.bottom + 1;
      }).map(node => node.textContent);
      return { width: root.width, height: root.height, textCount: document.querySelectorAll('#figure text').length, clipped };
    }, rendered.svg);
    if (geometry.clipped.length) throw new Error(`Clipped figure labels: ${name}: ${geometry.clipped.join(', ')}`);
    await page.locator('#figure').screenshot({ path: path.join(output, `${name}.png`) });
    reports.push({ name, ...rendered.compiler, sourceElements: rendered.sourceElements, geometry, svgBytes: Buffer.byteLength(rendered.svg), pngBytes: (await fs.stat(path.join(output, `${name}.png`))).size });
  }
  if (errors.length) throw new Error(`Browser export failed: ${errors.join('; ')}`);
  await fs.writeFile(path.join(output, 'export-report.json'), `${JSON.stringify({ upstreamRef: 'e12ec8001148d09c750badf71d3da4c97fb3fbbb', upstreamVersion: '0.5.1',
    localOnly: true, externalBrowserRequestsAllowed: false, renderer: 'Excalimate generatePlayerPackage + compileAnimatedSvg static poster / Chrome PNG', reports }, null, 2)}\n`);
  console.log(JSON.stringify({ reports, pageErrors: errors.length }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(work, { recursive: true, force: true }); }
