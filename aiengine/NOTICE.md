# NOTICE — @legado/aiengine

Portions of this module are derived from qingye-reader (https://github.com/wip3l/qingye-reader),
Copyright 李其健 and contributors, licensed under the GNU General Public License v3.0, taken from commit
8a783195b0da9191742e41f32086d084017439c3 (2026-10-24):

- entry/src/main/ets/core/reader/ComicTextRecognizer.ets
- entry/src/main/ets/core/reader/ComicTextTypes.ts
- entry/src/main/ets/core/reader/ReaderComicSuperResolution.ets
- entry/src/main/ets/core/reader/ReaderComicComputeQueue.ts
- entry/src/main/ets/core/reader/ComicChineseConverter.ets

Modifications (2026-11, R-HUA/legado-harmony): decoupled from the application through the AiRuntime host
interface, membership checks replaced by host authorization, Chinese conversion delegated to the host
ChineseConverter, colorization replaced by unsupported stubs. Each derived file carries a provenance header.

This module is distributed under GPL-3.0 without additional permissions.
