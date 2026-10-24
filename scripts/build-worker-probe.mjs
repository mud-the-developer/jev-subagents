// Same-checkout diagnostic only: no executable compilation or distributable artifact.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bunWorkerOptions } from '../src/worker-runtime.ts';

const native = globalThis.Bun;
assert.equal(process.versions.bun, '1.4.3'); bunWorkerOptions();
const root = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const entries = ['goal-sequence-worker', 'sol-pi-worker'].map(name => path.join(root, 'src', `${name}.ts`));
const sdk = JSON.parse(await fs.readFile(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
assert.equal(sdk.version, '0.85.1');
const fromSdk = createRequire(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
assert.equal(fromSdk('undici/package.json').version, '8.12.2');
const outputs = entries.flatMap(entry => [`.probe-esm.js`, `.probe-bytecode.js`, `.probe-bytecode.js.jsc`].map(suffix => path.basename(entry, '.ts') + suffix));
const manifestPath = path.join(root, 'src/goal-sequence-worker.probe-manifest.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let previous;
try {
  const stat = await fs.lstat(manifestPath); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  previous = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  assert.equal(previous.root, root); assert.equal(previous.bun, '1.4.3'); assert.equal(previous.sdk, '0.85.1'); assert.equal(previous.undici, '8.12.2');
  assert.deepEqual(Object.keys(previous.outputs).sort(), [...outputs].sort());
  assert.ok(Object.keys(previous.inputs).length > 0 && Object.keys(previous.inputs).length <= 5000);
  for (const [relative, expected] of Object.entries(previous.inputs)) {
    const file = path.resolve(root, relative);
    assert.ok(file.startsWith(root + path.sep) && !relative.split(/[\\/]/).includes('..'));
    assert.ok(/^(?:src[\\/]|node_modules[\\/])/.test(relative) || ['package.json', 'bun.lock', 'tsconfig.json', 'scripts/build-worker-probe.mjs'].includes(relative));
    assert.equal(digest(await fs.readFile(file)), expected, 'Trusted build input changed; prepare a fresh controlled snapshot.');
  }
  for (const name of outputs) {
    const file = path.join(root, 'src', name), stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal(digest(await fs.readFile(file)), previous.outputs[name], 'Generated artifact changed.');
  }
  console.log(JSON.stringify({ kind: 'same_checkout_worker_bundle_reuse', verifiedInputs: Object.keys(previous.inputs).length, artifacts: outputs.length,
    codeCacheOnly: true, permissionOrProfileResultsCached: false, publicUploadApproved: false }));
  process.exit(0);
}
for (const name of outputs) await assert.rejects(fs.lstat(path.join(root, 'src', name)), { code: 'ENOENT' });
const inputs = new Map(), outputDigests = {};
for (const relative of ['package.json', 'bun.lock', 'tsconfig.json', 'src/worker-bunfig.toml', 'scripts/build-worker-probe.mjs', 'node_modules/@earendil-works/pi-coding-agent/package.json'])
  inputs.set(relative, digest(await fs.readFile(path.join(root, relative))));
const guard = 'if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {';
for (const entry of entries) {
assert.equal((await fs.readFile(entry, 'utf8')).split(guard).length, 2);
for (const bytecode of [false, true]) {
  const suffix = bytecode ? 'bytecode' : 'esm';
  const executableEntry = path.join(root, 'src', `${path.basename(entry, '.ts')}.probe-${suffix}.js`);
  const result = await native.build({
    entrypoints: [entry], outdir: path.join(root, 'src'), target: 'bun', format: bytecode ? 'cjs' : 'esm', bytecode,
    bytecodeDepth: bytecode ? 1 : undefined,
    naming: { entry: `[name].probe-${suffix}.[ext]` }, env: 'disable', write: true,
    plugins: [{ name: 'preserve-original-module-identity', setup(build) {
      build.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/, namespace: 'file' }, async ({ path: source }) => {
        const bytes = await fs.readFile(source), relative = path.relative(root, source);
        assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative)); inputs.set(relative, digest(bytes));
        let text = bytes.toString('utf8');
        if (source.endsWith('.json') || !text.includes('import.meta')) return undefined;
        if (source.replaceAll('\\', '/').endsWith('/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')) {
          const start = '    const jiti = createJiti(import.meta.url, {';
          const end = '    const factory = module;';
          assert.equal(text.split(start).length, 2); assert.equal(text.split(end).length, 2);
          const first = text.indexOf(start), last = text.indexOf(end, first) + end.length;
          text = text.slice(0, first) + `    if (!__probeNativeSdkReady) {\n        globalThis.Bun.plugin({ name: 'jev-fixed-worker-sdk', setup(build) {\n            for (const [name, exports] of Object.entries(VIRTUAL_MODULES)) build.module(name, () => ({ exports, loader: 'object' }));\n        } });\n        __probeNativeSdkReady = true;\n    }\n    const factory = (await import(__probeToFileURL(extensionPath).href)).default;` + text.slice(last);
          const jitiImport = 'import { createJiti } from "jiti/static";'; assert.equal(text.split(jitiImport).length, 2);
          text = text.replace(jitiImport, "import { pathToFileURL as __probeToFileURL } from 'node:url';\nlet __probeNativeSdkReady = false;");
          const resolver = 'return fileURLToPath(import.meta.resolve(specifier));'; assert.equal(text.split(resolver).length, 2);
          text = text.replace(resolver, `return globalThis.Bun.resolveSync(specifier, ${JSON.stringify(path.dirname(source))});`);
        }
        if (path.resolve(source) === entry) {
          assert.equal(text.split(guard).length, 2);
          text = text.replace(guard, `if (process.send && process.argv[1] === ${JSON.stringify(executableEntry)}) {`);
          text = `import { VERSION as __probeSdkVersion } from '@earendil-works/pi-coding-agent';\nimport __probeUndiciPackage from 'undici/package.json';\nexport const __workerProbeMetadata = { sdkVersion: __probeSdkVersion, undiciVersion: __probeUndiciPackage.version };\nexport { bunWorkerOptions as __workerProbeRuntime } from './worker-runtime.ts';\nexport { DefaultResourceLoader as __workerProbeLoader, SettingsManager as __workerProbeSettings } from '@earendil-works/pi-coding-agent';\n${text}`;
        }
        const loader = /\.tsx$/.test(source) ? 'tsx' : /\.jsx$/.test(source) ? 'jsx' : /\.[cm]?ts$/.test(source) ? 'ts' : 'js';
        const transpiler = new native.Transpiler({ loader, target: 'bun', define: {
          'import.meta.url': JSON.stringify(pathToFileURL(source).href),
          'import.meta.dir': JSON.stringify(path.dirname(source)), 'import.meta.dirname': JSON.stringify(path.dirname(source)),
          'import.meta.file': JSON.stringify(path.basename(source)), 'import.meta.filename': JSON.stringify(source),
          'import.meta.path': JSON.stringify(source), 'import.meta.main': 'false',
        } });
        return { contents: transpiler.transformSync(text), loader };
      });
    } }],
  });
  if (result.logs.length) console.log(JSON.stringify({ kind: 'worker_bundle_build_diagnostic', bytecode,
    messages: result.logs.map(value => ({ level: value.level, message: value.message.replaceAll(root, '[checkout]').slice(0, 300) })) }));
  assert.equal(result.success, true, 'Native bundle probe build failed.');
  assert.ok(!bytecode || result.outputs.some(output => output.path.endsWith('.jsc')), 'Bytecode artifact missing; plain JS is not a bytecode pass.');
  for (const output of result.outputs) {
    assert.ok(outputs.includes(path.basename(output.path)));
    const stat = await fs.lstat(output.path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    const bytes = await fs.readFile(output.path);
    outputDigests[path.basename(output.path)] = digest(bytes);
    console.log(JSON.stringify({ kind: 'same_checkout_worker_bundle', bytecode, bytecodeDepth: bytecode ? 1 : null, name: path.basename(output.path), bytes: bytes.length,
      sha256: digest(bytes), undiciVersion: '8.12.2', sameCheckoutOnly: true, envInlining: false,
      dynamicExtensionResolution: 'original-module-bun-resolver', installedRuntimeChanged: false, publicUploadApproved: false }));
  }
}
}
assert.deepEqual(Object.keys(outputDigests).sort(), [...outputs].sort());
await fs.writeFile(manifestPath, JSON.stringify({ root, bun: '1.4.3', sdk: '0.85.1', undici: '8.12.2',
  inputs: Object.fromEntries([...inputs].sort()), outputs: outputDigests }, null, 2) + '\n', { flag: 'wx' });
