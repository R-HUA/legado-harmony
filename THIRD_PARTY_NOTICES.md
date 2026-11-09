# 第三方开源软件声明

本项目及其发行的 HAP 包含下列第三方开源软件。项目自身的 GPL-3.0 许可证不替代这些组件各自的许可证、版权声明或免责声明。

## ohos_quickjs

- 组件：`@devzeng/quickjs` / `ohos_quickjs`
- 上游项目：https://github.com/hhtczengjing/ohos_quickjs
- 许可证：MIT
- 版权所有：Copyright (c) 2026 zengjing

本项目对该组件进行了 HarmonyOS 集成、稳定性和能力扩展方面的修改。该组件随书源解析内核一起放在子模块 `harmony-book-source-engine/quickjs/`，原始 MIT 许可见 [harmony-book-source-engine/quickjs/LICENSE](harmony-book-source-engine/quickjs/LICENSE)，发行包内许可合集见 [THIRD_PARTY_LICENSES.txt](entry/src/main/resources/rawfile/licenses/THIRD_PARTY_LICENSES.txt)。

## QuickJS

- 组件：QuickJS JavaScript Engine
- 上游项目：https://bellard.org/quickjs/
- 许可证：MIT
- 版权所有：Copyright (c) 2017-2021 Fabrice Bellard；Copyright (c) 2017-2021 Charlie Gordon

## OpenHarmony / Huawei N-API 封装代码

- 组件：带有 Huawei Device Co., Ltd. 版权头的 N-API 封装源文件
- 许可证：Apache License 2.0
- 版权所有：Copyright (c) 2021-2022 Huawei Device Co., Ltd.

本项目修改过的相关文件继续保留原始版权和许可证头；修改内容主要包括 QuickJS 运行时适配、句柄安全、受限执行和 HarmonyOS 应用集成。

## OpenCC 繁简转换词典

- 组件：OpenCC 中文转换词典数据（TSCharacters.txt / TSPhrases.txt / STCharacters.txt / STPhrases.txt / TWVariants.txt）
- 上游项目：https://github.com/BYVoid/OpenCC/tree/ver.1.1.9
- 版本：ver.1.1.9
- 许可证：Apache License 2.0
- 版权所有：BYVoid 及 OpenCC 贡献者

词典文本随 `entry/src/main/resources/rawfile/chinese/` 原样打包（仅改文件名：`t2s_*`、`s2t_*`、`tw_variants.txt`），由应用唯一的简繁实现 `ChineseConverter` 使用：阅读正文与章节名的简繁转换、规则引擎 `java.t2s` / `java.s2t`、搜索关键词的简繁互转（台湾用字），以及 `aiengine` 漫画对白繁→简（经宿主接口）。应用自行实现词组最长匹配适配器，不包含完整 OpenCC 引擎。完整许可文本见发行包内 [THIRD_PARTY_LICENSES.txt](entry/src/main/resources/rawfile/licenses/THIRD_PARTY_LICENSES.txt)。

## acorn

- 组件：acorn JavaScript 解析器（压缩后内置于 `harmony-book-source-engine/sourceengine/src/main/ets/core/book/StageScriptParserSource.ts`，由 `harmony-book-source-engine/scripts/generate-stage-script-parser.mjs` 生成）
- 上游项目：https://github.com/acornjs/acorn
- 许可证：MIT
- 版权所有：Copyright (C) 2012-2022 by various contributors

用于在分阶段运行时里解析兼容书源脚本，使脚本返回值与 Android 端 Rhino 一致。

## 本地 aiengine 模块

`aiengine/` 中的漫画文字识别与超分代码来自 qingye-reader 提交 `8a783195b0da9191742e41f32086d084017439c3`（GPL-3.0），按 GPL-3.0 再分发，来源与改动见 [aiengine/NOTICE.md](aiengine/NOTICE.md)。本构建不包含上游的漫画着色模型（Manga-Colorizer / AlacGAN）。

## 完整许可文本

为确保源码和二进制发行均携带必要声明，MIT 与 Apache-2.0 的完整许可文本统一存放于：

- [entry/src/main/resources/rawfile/licenses/THIRD_PARTY_LICENSES.txt](entry/src/main/resources/rawfile/licenses/THIRD_PARTY_LICENSES.txt)

该文件会作为 rawfile 打包进入最终 HAP，并可在应用“关于 → 开源许可”中查看。
