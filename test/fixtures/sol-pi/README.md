# Pinned upstream fixture

Unmodified NVlabs/SoL-Pi 0.1.0 sources from commit
`bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`:
<https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1>.

The 23 TypeScript modules and [MIT license](LICENSE) match
[`src/sol-pi-source.ts`](../../../src/sol-pi-source.ts). Upstream `package.json`
is retained as provenance, not installed. Root TypeScript checking excludes
this fixture because its peer imports are resolved by the actual pi SDK
extension loader, which `test/sol-pi.test.ts` exercises offline.

No upstream test-suite count, live-model quality, cost savings or security
isolation is claimed by this fixture. See the [integration contract](../../../docs/sol-pi.md).
