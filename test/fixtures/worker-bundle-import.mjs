// Synthetic import-only child; no worker request or execution authority is produced.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.fetch = async () => { throw new Error('Network forbidden in bundle import probe.'); };
process.once('message', async input => {
  try {
    assert.equal(typeof input.bundle, 'string');
    const before = process.listenerCount('message'), mask = process.umask();
    const module = await import(pathToFileURL(input.bundle).href);
    const after = process.listenerCount('message');
    const loader = new module.__workerProbeLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager: module.__workerProbeSettings.inMemory({ packages: [] }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [input.extension] });
    await loader.reload();
    const resources = loader.getExtensions(), loaderReady = resources.errors.length === 0 && resources.extensions.length === 1;
    resources.runtime.invalidate();
    const runtime = module.__workerProbeRuntime({ JEV_BUN_EXECUTABLE: process.execPath });
    const result = { type: 'bundle_import_probe', sdkVersion: module.__workerProbeMetadata.sdkVersion, undiciVersion: module.__workerProbeMetadata.undiciVersion,
      inert: before === after && mask === process.umask(), loaderReady, runtimeFileMatches: runtime.execPath === process.execPath,
      configExists: runtime.execArgv.some(value => value === `--config=${path.join(input.source, 'worker-bunfig.toml')}`),
      synthetic: true, liveModels: false };
    process.send(result, () => process.exit(0));
  } catch { process.exit(1); }
});
