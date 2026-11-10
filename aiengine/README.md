# @legado/aiengine（本地 GPL-3.0 构建）

R-HUA/legado-harmony 的端侧 AI 内核 HAR 模块。上游 qingye-reader 4.4.930 起把这些能力移进了私有子模块
`harmony-book-ai-engine`（无法获取，且其后改为专有许可）；本模块改为从上游**最后一个仍以 GPL-3.0 公开的提交**
恢复所需部分，并按上游 4.6.007 调用方使用的 API 打包为本地模块，供 `entry` 以 `@legado/aiengine` 导入。

## 来源

| 文件 | 上游路径（wip3l/qingye-reader @ `8a783195b0da9191742e41f32086d084017439c3`，2026-10-24，GPL-3.0） | 改动 |
| --- | --- | --- |
| `src/main/ets/core/reader/ComicTextRecognizer.ets` | `entry/src/main/ets/core/reader/ComicTextRecognizer.ets` | entry 依赖改为宿主接口 |
| `src/main/ets/core/reader/ComicTextTypes.ts` | `entry/src/main/ets/core/reader/ComicTextTypes.ts` | 无 |
| `src/main/ets/core/reader/ReaderComicSuperResolution.ets` | `entry/src/main/ets/core/reader/ReaderComicSuperResolution.ets` | 会员判断改为宿主授权；entry 依赖改为宿主接口；`enhance()` 增加可选第 4 参数；处理本地源图时经 `retainComicFile` 租用文件 |
| `src/main/ets/core/reader/ReaderComicComputeQueue.ts` | `entry/src/main/ets/core/reader/ReaderComicComputeQueue.ts` | 无 |
| `src/main/ets/core/reader/ComicChineseConverter.ets` | `entry/src/main/ets/core/reader/ComicChineseConverter.ets` | 会员判断改为宿主授权；字典改由宿主提供 |

`8a783195` 是上游把这些文件移入子模块（`4c6c35a8`）之前的最后一个提交；专有许可与“AI 引擎链接例外”是之后的
`38399efe` 才加入的，因此上述文件在该提交中仍是 GPL-3.0。每个文件开头注明了来源与改动。

`ComicTextRequests.ts` 在上游 4.6.007 中仍位于 entry，未移入本模块。

## 本地新增（非上游代码）

- `runtime/AiRuntime.ets`：`AiHost`（授权、缓存目录、图片下载、摘要、漫画缓存记账、图片标记解析）与
  `AiChineseTextHost`（简繁转换）宿主接口；引擎不 import `entry` 的任何模块。
- `TextTranslator.ets`、`ComicChineseDictionary.ts`、`ChineseTaiwanConverter.ts`：繁简转换外观，全部委托宿主的
  `ChineseConverter`（应用内唯一的简繁实现与字典，OpenCC 1.1.9 数据，见应用的 `rawfile/chinese/`）。
- `ComicColorizer.ets`、`ReaderComicColorSession.ets`、`Worker.ets`：**漫画着色不包含在本构建中**。只保留上游
  调用方需要的 API 形状：`ComicColorizer.supported()`/`memberAllowed()` 恒为 `false`，`colorize()`/`prepare()`/
  `ComicColorModels.download()` 拒绝执行，`ReaderComicColorSession` 为惰性会话，`startComicColorWorker()` 直接关闭 worker。
  不包含 alac.ms 模型、ComicColor* worker 与着色调度。

## 许可

GPL-3.0（与应用相同，见仓库根目录 `LICENSE`）。本模块不适用、也不需要任何链接例外。
