# 系统朗读验证

## 接口依据

核对日期：2026-10-06。项目最低兼容 API 12，目标 API 26。

- [系统文本转语音 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/hms-ai-texttospeech)，页面更新时间 2026-09-23。
- `CreateEngineParams`、`VoiceQuery`：系统仅支持 `online: 1`，区域参数仅支持 `CN`，后台播报在引擎创建时设置 `isBackStage: true`。
- `VoiceInfo`：`GA` 可下载，`INSTALLED` 已下载，`EOM` 不可用；`status` 从 API 19 开始提供。模块级查询和下载从 API 19 开始支持，旧版本沿用引擎实例查询。
- `VoiceDownload`：语言、音色和风格来自系统查询结果。`1002300010` 表示已经下载；应用仍须刷新音色状态，确认可用后才选择。
- `speak`：文本不超过 10,000 字符；`playType: 0` 返回 PCM，`playType: 1` 直接播报。`CompleteResponse.type: 0` 为合成结束，`1` 为播报结束。
- `onData`：音频数据按 `sequence` 排序，序号从零开始。直接播报使用通道 `3`，避开官方明确指出的通道 `1`、`12` 息屏截断问题。
- 本机 SDK 类型：`sdk/default/hms/ets/api/@hms.ai.textToSpeech.d.ts`。项目补充声明只用于编译类型兼容，不能证明真机服务行为。

## 本地回归

```powershell
node scripts/system-tts-check.mjs
node scripts/local-features-check.mjs
node scripts/theme-framework-check.mjs
node scripts/thread-blocking-check.mjs
node scripts/neutral-source-engine-check.mjs
devecocli build --modules entry --product default
```

系统朗读脚本执行生产代码，系统服务、存储和播放输出使用可控替身。它验证调用契约、异步终态、字符映射和播放完成边界，不证明设备上的声音、下载、音频路由或后台持续运行。

音色选择采用系统实时状态；旧的本地下载记录不覆盖系统结果。查询失败保留当前选择并提供刷新。系统朗读使用现有短语音分块，PCM 高亮由播放器时间线推进，排空后才进入下一章。

直接播报兜底与 PCM 播放分别验收。直接播报暂停后从当前语音块开头恢复；只有当前请求的播报完成回调才能前进，回调超时提示重试，不按估算时间宣告成功。

## 真机验收步骤

准备本地或已缓存的中文、英文正文；连续至少三章，其中一章超过 10,000 字符。记录应用版本、设备型号、系统/API、音色和语速。

| 场景 | 操作与通过标准 |
| --- | --- |
| 默认女声 | 不登录账号试听聆小珊；关闭网络后朗读本地正文，声音正常、没有账号或后端请求。 |
| 音色下载 | 分别下载凌飞哲、美国英语 Laura；确认进度与成功状态，断网后试听与连播。取消、断网失败或不可用状态不改变原选择。 |
| 系统状态变化 | 音色在系统侧被移除后刷新，不因旧下载记录显示已安装；重新下载成功后才能启用。 |
| 长章节跨章 | 从正文中间开始连续至少三章；覆盖无标点长句、表情、装饰行和标点尾部。无漏读、提前跳章或内部标记被读出。 |
| 锁屏 | PCM 路径锁屏连续播放至少 30 分钟并跨章；锁屏暂停、继续、切章控制有效，解锁后高亮与保存进度对应当前声音。 |
| 页面切换 | 手动翻页、离开阅读页、回到书架再打开书籍；浮动控制有效，旧页面或旧章节回调不覆盖当前位置。 |
| 中断与失败 | 覆盖音频焦点中断、后台任务申请失败和正文加载失败；失败明确提示并留在最后确认位置，停止后没有残留声音。 |
| 直接播报 | 使用开发测试替身让当前请求不返回 PCM，确认仅切换一次。锁屏连续播放至少 30 分钟并跨章，独立验证音量控制；暂停后重播当前块，缺失完成回调时停止而不跳章。 |
| 自定义 HTTP 音色 | 导入、选择、试听、连续播放与禁用行为正常；系统音色查询失败不清空自定义选择。 |

故障注入仅用于开发测试，不在正式设置中增加测试开关。进程被回收后的自动续播不属于本次验收范围。

## 验收记录

2026-10-06 本地验证：

- `system-tts-check.mjs`：18 组行为检查通过。
- `local-features-check.mjs`、`theme-framework-check.mjs`、`thread-blocking-check.mjs`、`neutral-source-engine-check.mjs`：通过。
- `git diff --check`：通过。
- `devecocli build --modules entry --product default`：成功生成 `entry/build/default/outputs/default/entry-default-signed.hap`。构建仍有项目现存的弃用与版本兼容警告，不等同于 lint 全通过。

本机默认全局 Hvigor 守护进程缓存受访问权限限制，验证时仅为当前命令设置项目内缓存，未删除全局锁或修改项目 SDK、签名及构建配置：

```powershell
$env:HVIGOR_USER_HOME = Join-Path (Get-Location) '.hvigor-tts'
$env:npm_config_cache = Join-Path (Get-Location) '.hvigor-tts/npm-cache'
devecocli build --modules entry --product default
```

真机下载、断网声音表现、三章连播、两种播放路径各 30 分钟锁屏，以及视觉交互尚未执行，保持待验收。设备连接状态不能替代这些场景的通过证据。
