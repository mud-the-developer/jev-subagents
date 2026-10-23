# Third-party notices

The root [MIT license](LICENSE) covers this project's original work. It does not replace third-party copyright or license notices.

## Pinned SoL-Pi regression fixture

`test/fixtures/sol-pi/` contains the pinned NVlabs/SoL-Pi 0.1.0 fixture from commit `bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1`.

- Upstream: <https://github.com/NVlabs/SoL-Pi/tree/bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1>
- Copyright: (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
- License: MIT. Preserve the full notice in [test/fixtures/sol-pi/LICENSE](test/fixtures/sol-pi/LICENSE) and the existing SPDX headers whenever those files are included.
- This is a regression fixture, not an installed or publicly activated SoL-Pi integration. Its provenance is documented in [the fixture README](test/fixtures/sol-pi/README.md).

## Separately installed dependencies

Runtime and development dependencies retain their own licenses and attribution requirements. They are installed from the frozen Bun lock; `node_modules` is not part of the source ZIP. The installed dependency license files remain authoritative for those packages.

This notice records the identified vendored fixture; it is not an exhaustive legal or public-content audit. Public release preparation must still review the exact final file set and preserve any other applicable notices.
