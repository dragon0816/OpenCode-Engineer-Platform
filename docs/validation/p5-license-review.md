# Phase 5 license review

OEP ships under its repository [MIT license](../../LICENSE). The current standard release inventory uses no strong copyleft, unknown or custom license exceptions. The release gate keys an exception to a specific versioned package URL and license, and requires a written justification.

| Components | License | Compatibility with OEP MIT |
| --- | --- | --- |
| OpenCode 2.3.2, @opencode/client 2.3.2, @opencode/protocol 2.3.2, @opencode/schema 2.3.2 | MIT | Compatible with distribution alongside OEP. Retain the upstream copyright and license. |
| @standard-schema/spec 1.1.0, effect 4.1.0, fflate 0.8.3 | MIT | Compatible with distribution alongside OEP. Retain each package's copyright and license. |
| openpyxl 3.1.5 | MIT | Compatible with OEP. Retain the openpyxl copyright and license from its pinned source distribution. |
| et-xmlfile 2.0.0 | MIT AND Python-2.0.1 | Compatible with separate distribution alongside OEP. Preserve both license files, including the standard-library terms supplied upstream. |
| defusedxml 0.7.1 | PSF-2.0 | Compatible with distribution alongside OEP. Preserve the upstream PSF license and notice. |
| Node.js 24.14.1 (bundled) | MIT, with third-party terms reproduced in the Node distribution LICENSE | The Node.js project license permits distribution alongside OEP. Review the embedded dependency terms and retain the complete aggregate text. |
| Python 3.12.10 (bundled) | Python-2.0.1 | Compatible with distribution alongside OEP. Retain the embedded package's full LICENSE.txt and review the bundled binary terms. |

The three OpenCode npm tarballs omit license text. The release uses the root MIT text at the [pinned OpenCode source commit](https://github.com/anomalyco/opencode/blob/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1/LICENSE). Before approving redistribution, the owner should confirm the root license covers the Windows binary and npm packages and check the binary's embedded third-party obligations.

The tracked-tree review searched executable sources and fixtures for copyright and SPDX headers, attribution to copied or ported code, and AEP references. AEP references identify compatibility readers, format verification, feature comparisons and synthetic fixtures. The marker search found no evidence of copied AEP code. The prior finding that AEP has no general root license still applies to any proposed reuse. The owner should confirm provenance against the read-only AEP source before closing this review. A marker search cannot establish source equivalence.

Python texts were collected from the hash-locked defusedxml wheel and the PyPI source releases of et-xmlfile and openpyxl. The source-archive SHA-256 values are `dab3f4764309081ce75662649be815c4c9081e88f0837825f90fd28317d4da54` and `cf0e3cf56142039133628b5acffe8ef0c12bc902d2aadd3e0fe5878dc08d1050`, respectively. [defusedxml](https://pypi.org/project/defusedxml/0.7.1/) · [et-xmlfile](https://pypi.org/project/et-xmlfile/2.0.0/) · [openpyxl](https://pypi.org/project/openpyxl/3.1.5/)
