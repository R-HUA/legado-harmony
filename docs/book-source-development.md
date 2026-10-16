# 书源规则开发文档

轻页和简听共用的规则格式、字段、表达式、选择器及示例已迁至公共引擎仓库，本文仅保留入口，不再维护副本。

- [公共书源规则开发文档](https://github.com/wip3l/harmony-book-source-engine/blob/feat/source-cover-decode/docs/book-source-development.md)
- [封面解密 coverDecode](https://github.com/wip3l/harmony-book-source-engine/blob/feat/source-cover-decode/docs/book-source-development.md#加密封面-coverdecode)
- [宿主图片加载接入](https://github.com/wip3l/harmony-book-source-engine/blob/feat/source-cover-decode/docs/cover-decoding.md)

目前链接指向待合并的公共引擎 PR #2 分支。合并后可切换为 main。新增格式能力需要同步升级引擎和对应宿主适配；本次文档迁移不表示轻页已经接入封面解密 UI。

修改规则格式与开发说明请在公共引擎仓库提交。轻页只维护自己的页面、导入/调试操作和宿主接入说明。

本地引擎实现与规则说明位于 [引擎子模块](../harmony-book-source-engine/docs/book-source-development.md)。发布书源前可运行 `node scripts/legado-rule-grammar-check.mjs <书源.json>` 检查上游 CSS 前缀与索引语义；该静态检查不能替代站点运行。
