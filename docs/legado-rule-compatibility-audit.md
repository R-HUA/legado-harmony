# 阅读书源规则兼容检查

检查日期：2026-09-30。对象：当前 feature 分支的生产代码及本次修复。

参考入口：[用户指定的书源教程](https://mgz0227.github.io/The-tutorial-of-Legado/Rule/source.html)。语义同时核对 [Legado AnalyzeByJSoup](https://github.com/gedoor/legado/blob/master/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeByJSoup.kt)、[AnalyzeRule](https://github.com/gedoor/legado/blob/master/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt) 和 [JsExtensions](https://github.com/gedoor/legado/blob/master/app/src/main/java/io/legado/app/help/JsExtensions.kt)。以下样例独立构造，未复制教程的示例书源。

## 结论与实际故障

本项目不能称为完整兼容阅读书源。存在三个不同层次的缺口：规则提取语义、JavaScript 执行路由、Android/Java 宿主接口桥接。导入 JSON 成功、能力分析器没有报告缺失、ArkTS 编译成功，都不能证明导入书源能正确工作。

ESJ 正文原规则：

```text
@css:div.forum-content.mt-3,div[class =d_post_content j_d_post_content]@all
```

原实现把 `all` 当成属性名，属性条件解析失败又丢弃条件，正文失败后通用提取还会捡到举报表单。已修复 `@all`、属性等号周围空格、显式 CSS 分组和失败条件的处理；显式正文规则无有效内容时返回失败，不把页面控件充作正文。

当前手机 ESJ 目录规则还使用 `org.jsoup.Jsoup.parse(result).select(...)`、`remove()` 和 `eachText()`，之后将 HTML 交给尾部的 `a` 规则提取。原路径既未路由到完整 JS，也未提供 Jsoup 桥接，HTML 章节项还会被只接受 JSON 对象的目录转换器丢弃。本次补充 detached DOM 的有限 Jsoup 桥接、HTML 章节上下文和阶段脚本执行路径。桥接只实现有验证的集合操作，不代表移植了整个 Java Jsoup 库。

## 按能力对照

| 能力 | 当前结论 | 实现/验证依据及限制 |
| --- | --- | --- |
| 常用默认选择器 | 部分支持 | `class/id/tag`、普通正负索引、部分排除、children、text、ownText 等已有实现。`tag.p[0,2]`、`tag.p[!0,-1]`、`tag.p[0:3:2]` 实测为空；不能等同完整索引语言。 |
| CSS | 部分支持 | ID、class、属性、后代/子节点、简单 has/not/eq 等可用。本次补 all、ownText/textNodes 分发与 html 去除 script/style。`p + p`、`nth-child(odd)` 无结果；分组按规则分组顺序拼接而非文档顺序。textNodes 仍会包含后代文本。底层是字符串扫描，不是完整 Jsoup DOM。 |
| XPath | 部分支持且有错误结果风险 | 本次修复 `//a/@href` 被误当 URL 字面量，并识别标量 `@XPath:` 前缀。底层把简单 XPath 翻译成 CSS；`text()="C"`、`position()>1` 谓词可能被丢弃而返回所有节点，`/` 和 `//` 层级混淆，兄弟轴不完整。不能宣称 XPath 1.0 或 JsoupXpath 兼容。 |
| JSONPath | 常用子集支持 | wildcard、recursive property、数字比较过滤在独立样例通过。Jayway 聚合函数如 `length()` 不支持；不能仅凭 JSONPath 文件名声称完整 Jayway 兼容。 |
| 正则、组合、变量、模板 | 常用功能已有覆盖，非完整证明 | 已有 `##`、AllInOne 捕获上下文、`&&/\|\|/%%`、put/get、JSON/CSS 模板及 Java 正则兼容测试。本次修复模板内 CSS 执行和残留规则文本泄漏。任意提取/JS/正则交错、类型和转义组合仍需上游差分测试。 |
| 完整 JS | 有完整引擎，但调用路径部分兼容 | 项目已有 NAPI QuickJS 和分阶段 ArkWeb；轻量 ArkTS 解释器只支持子集。原 `while` 进入轻量解释器返回空，本次路由到 ArkWeb；简单完整阶段脚本也不再因为路由认为“简单”而被漏执行。纯表达式 QuickJS、字段脚本、URL 脚本与阶段脚本的覆盖仍不相同。 |
| Ajax、POST options、Cookie | 已验证指定书源用法 | 原始轻之国度书源的目录/正文 POST options、JSON.parse、指定 Cookie 名通过生产桥接 fixture 测试。本次统一 native/webView 前 Cookie 准备，显式 Cookie 大小写不重复。网站登录状态仍依赖实际 Cookie 域名/路径/有效期及服务器响应，fixture 不证明手机已登录。 |
| java/source/cache/cookie 接口 | 有限桥接 | getCookie、部分编码/摘要/加密、getString/List、put/get 等已有实现。`java.getElements`（复数）未提供，不能用现有 getElement（单数）代替。connect、downloadFile、文件/ZIP、字体解析与替换等缺少对应完整桥接；AES 方法/重载覆盖也不完整。 |
| Packages / JavaImporter / Jsoup | 局部仿真 | 运行环境没有 Android JVM。Packages 和 JavaImporter 的部分实现是兼容占位；本次 org.jsoup 仅补 parse/select/remove/eachText/text/size/get/attr/字符串化。不会自动支持任意 java/javax 类、Jsoup 专用伪类或 DOM 方法。 |
| URL 选项 | 部分支持 | method/body/headers/charset/retry/webView 等有实现。`AnalyzeUrl.parseOption` 没有执行教程所述 options.js / java.headerMap / java.url 改写。header 中 proxy 也未发现对应代理传输配置。 |
| 详情和目录阶段 | 基本链路已有实现 | 详情 init、章节字段/VIP/分页有实现。本次补 HTML 阶段结果。下一页通过单个 URL 字段执行，数组分支的多路径遍历未完整实现。canReName 没有对应明确执行字段。 |
| 正文与资源能力 | 部分支持 | 正文/标题/图片、替换净化、下一页及音频 sourceRegex 专用路径已有实现。imageDecode/imageStyle 等导入字段不能据此认定都已执行；正文级 webJs 的页面执行和音频/文本差异仍需专项检查。 |

## 为什么两个目录入口表现不同

`ReadBookEngine.openBookFresh` 优先读缓存；缺目录时 `refreshToc` 以 `allowGenericFallback = chapters.length === 0` 调用 `WebBookService.getChapterList`。正式规则失败后可生成临时通用目录，并不会把它持久化为正式目录。

`BookChapterList.loadChapters` 也先读数据库缓存；没有缓存时明确传 `false` 禁用通用目录，所以显示正式规则失败的错误。这是调用策略差异，同一个生产解析器并没有因为入口不同而自动获得更多规则能力。此前手机直接阅读成功，不能证明当前 ESJ 正式目录脚本执行成功；缺对应历史日志时不能断言当时是哪条兜底路径。

## 验证证据与边界

- `node scripts/legado-rule-compat-audit.mjs`：独立合成 HTML/JSON/JS，用实际 AnalyzeRule、ScriptEngine、Router、AnalyzeUrl 运行 31 个检查，逐项输出 expected/actual。脚本可正常结束并同时报告缺口，退出 0 不代表全部规则兼容。样例数量不能换算总体兼容率。
- `scripts/esj-source-compat-check.mjs`：本机 Chrome 的真实 DOM 执行生产 ArkWeb 桥接，运行手机当前 ESJ 目录脚本，接生产目录字段转换得到三个正确 URL 和预期标题；while 返回 3。需要已安装 Chrome、Playwright，可由 NODE_PATH 指向已有依赖。响应 HTML 是合成数据，不是网站实测。
- `scripts/search-source-compat-check.mjs`：实际生产搜索/URL/字段/正文代码，平台 HTTP 用响应 fixture，故意令原生 QuickJS 创建失败。原始轻之国度 JSON 加已捕获的“乙女游戏”搜索响应得到 17 条结果；模板、标签、Cookie 诊断和 ESJ 正文/举报表单隔离断言通过。
- `scripts/stage-source-compat-check.mjs`：指定原始轻之国度 JSON，20 卷、22 个 POST、命名 Cookie、登录重试、正文 ruby 和图片断言通过；平台 HTTP/数据库/WebView 以 mock 代替，未访问网站。
- 线程阻塞和中立规则引擎门禁通过，修复源码已通过 DevEco CLI ArkTS 构建并覆盖安装。用户在手机从独立目录入口进入章节并刷新正文后，反馈“均正常”；这是 ESJ 当前书籍的验收，不代表所有书源兼容。

## 后续完整兼容方案

1. 先修复选择器及 XPath 的确定语义，禁止不认识的条件被静默丢弃。建立可在 Android 上游与本项目运行相同合成输入的差分套件，比较节点、顺序、捕获组和空值，而非只检查能否导入。
2. 统一受限的完整 JS 执行入口。当前 ArkWeb 可解决普通 JS 语法；长期可将 QuickJS 作为主执行引擎并通过 NAPI 提供宿主服务，保留超时、取消、网络预算和副作用日志。
3. 单独实现阅读宿主 API 与 HTML/CSS/XPath/JSONPath 语义。换 JS 引擎不会自动产生 java.ajax、CookieStore、Java 包或 Jsoup；同步 Ajax 在异步平台上还需保证请求顺序与避免脚本重放重复 POST。
4. 在导入和调试中报告实际缺失接口及失败阶段，区分网络、验证、解析和临时兜底。不同目录入口对兜底的使用也应清晰显示。

因此问题不是“ArkTS 没有进程内 JS 引擎，所以只能如此”。本项目已经集成 QuickJS，并用 ArkWeb 执行完整 JS；完整兼容的主要工作仍是统一执行路径、补齐规则语义和宿主 API。当前修复针对已复现的问题，尚不构成对所有阅读书源的完整兼容承诺。
