# AI 模块（本地 `aiengine/`）

本 fork（R-HUA/legado-harmony）不使用上游的私有子模块 `harmony-book-ai-engine`。AI 能力放在仓库内的本地 HAR 模块
[`aiengine/`](../aiengine/README.md)，包名仍是 `@legado/aiengine`，导出上游主程序用到的同一套 API，主程序无需区分。
克隆和构建都不需要任何私有仓库或凭据，CI 也不再需要 `AI_ENGINE_READ_TOKEN`。

## 包含什么

| 能力 | 来源 | 说明 |
| --- | --- | --- |
| 漫画文字识别（OCR） | 上游 `8a783195` 的 `ComicTextRecognizer.ets` / `ComicTextTypes.ts` | 系统 CoreVisionKit 文字识别，分块、行框映射、底色判断与文字层 |
| 漫画 / PDF 超分 | 上游 `8a783195` 的 `ReaderComicSuperResolution.ets` | 系统 CoreVisionKit 图片超分，API 26 起；不含上游后续私有引擎的 C++ 逐块核对 |
| 漫画对白繁→简、简繁同搜、`TextTranslator` | 本 fork 新写的薄层 | 全部委托应用唯一的简繁实现 `entry/src/main/ets/utils/ChineseConverter.ts`（OpenCC 1.1.9 字典在 `entry/src/main/resources/rawfile/chinese/`） |
| 漫画 AI 着色 | **不包含** | `ComicColorizer.supported()` 返回 `false`，`ReaderComicColorSession` 惰性，`startComicColorWorker` 直接关闭；界面隐藏着色入口，不携带任何模型 |

`8a783195` 是上游把这些文件移入私有子模块（`4c6c35a8`）之前的最后一个 GPL-3.0 公开提交。逐文件来源与改动见
[`aiengine/README.md`](../aiengine/README.md) 和 [`aiengine/NOTICE.md`](../aiengine/NOTICE.md)。

## 与主程序的边界

引擎不导入 `entry` 的任何模块。主程序在 `EntryAbility.onCreate` 调用 `AppAiHost.install()`，即
`AiRuntime.install(new AppAiHost(), new AppChineseTextHost())`：

- `AiHost`：授权（`isAllowed`，`COMMERCE_ENABLED=false` 时全部放行）、缓存目录、图片下载、摘要、漫画缓存记账
  （`touchComicFile` / `noteComicWrite` / `retainComicFile`）、阅读器图片标记解析。
- `AiChineseTextHost`：繁→简、简→繁、简→繁（台湾用字）的加载与转换，全部转到 `ChineseConverter`。

会员判断不在引擎内：`AiAccessPolicy`（主程序）在商业服务关闭时直接放行三项端侧能力。

## 检查

- `scripts/comic-text-check.mjs`：OCR 几何、取色、文字层、缓存、引擎复用与长按菜单。
- `scripts/comic-colorizer-check.mjs`：着色接口均报告不支持、会话惰性、Worker 关闭、界面隐藏。
- `scripts/member-reader-settings-check.mjs`、`scripts/ai-trial-check.mjs`、`scripts/ai-host-runtime-check.mjs`：
  商业服务开启时的授权路径与宿主接口。
- `scripts/chinese-converter-check.mjs`、`scripts/reader-text-convert-check.mjs`、`scripts/search-simp-trad-check.mjs`：
  简繁转换的唯一实现及其接入点。
