# 系统朗读验证

## 接口依据

核对日期：2026-10-06。项目最低兼容 API 12，目标 API 26。

- [系统文本转语音 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/hms-ai-texttospeech)，页面更新时间 2026-09-23。
- `CreateEngineParams`、`VoiceQuery`：系统仅支持 `online: 1`，区域参数仅支持 `CN`，后台播报在引擎创建时设置 `isBackStage: true`。
- `VoiceInfo`：`GA` 可下载，`INSTALLED` 已下载，`EOM` 不可用；`status` 从 API 19 开始提供。模块级查询和下载从 API 19 开始支持，旧版本沿用引擎实例查询。
- `VoiceDownload`：语言、音色和风格来自系统查询结果。`1002300010` 表示已经下载；应用仍须刷新音色状态，确认可用后才选择。
- `speak`：文本不超过 10,000 字符；`playType: 0` 返回 PCM，`playType: 1` 直接播报。`CompleteResponse.type: 0` 为合成结束，`1` 为播报结束。
- `onData`：音频数据按 `sequence` 排序，序号从零开始。直接播报使用通道 `3`，避开官方明确指出的通道 `1`、`12` 息屏截断问题。
- `onComplete` 的合成结束不保证全部 `onData` 已到达；官方 API 明确提醒继续接收音频回调。分片收集须保留当前请求，不能立即合并、启动下一段或切换直接播报。
- [基础语音官方 FAQ](https://developer.huawei.com/consumer/cn/doc/doccenter-dev-faq/faqs-core-speech-kit)中的“文本转语音引擎使用问题”：同名引擎可能互相影响，关闭一个页面实例后，另一实例可报 `1002300007`。每次创建引擎使用唯一名称，覆盖试听、阅读及旧版本音色查询。正文从 DevEco CLI 的 `FAQ/机器学习/基础语音_Core_Speech/文本转语音引擎使用问题/faqs-core-speech-1` 读取。
- 本机 SDK 类型：`sdk/default/hms/ets/api/@hms.ai.textToSpeech.d.ts`。项目补充声明只用于编译类型兼容，不能证明真机服务行为。

## 本地回归

```powershell
node scripts/system-tts-check.mjs
node scripts/tts-pcm-output-check.mjs
node scripts/tts-text-split-check.mjs
node scripts/local-features-check.mjs
node scripts/theme-framework-check.mjs
node scripts/thread-blocking-check.mjs
node scripts/neutral-source-engine-check.mjs
devecocli build --modules entry --product default
```

系统朗读脚本执行生产代码，系统服务、存储和播放输出使用可控替身。它验证调用契约、异步终态、字符映射和播放完成边界，不证明设备上的声音、下载、音频路由或后台持续运行。

音色选择采用系统实时状态；旧的本地下载记录不覆盖系统结果。查询失败保留当前选择并提供刷新。系统朗读使用现有短语音分块，PCM 高亮由播放器时间线推进，排空后才进入下一章。

直接播报兜底与 PCM 播放分别验收。直接播报暂停后从当前语音块开头恢复；只有当前请求的播报完成回调才能前进，回调超时提示重试，不按估算时间宣告成功。

设置页的系统音色试听使用 `playType: 1` 直接播报，语速由合成引擎设置，音调保持 `pitch: 1`；正文继续使用应用内的 PCM 播放器，以保留音频时间线与后台播放。自定义 HTTP 音色沿用自己的合成和播放路径。

## 2026-10-13 故障复核

用户确认默认聆小珊在正文提示“系统音频数据无效”，长章节闪退，试听语速、语调异常。该提示来自系统 PCM 合并或采样帧校验，不能据此判断为 HTTP 获取失败。

本次重新检索官方 API、官方 FAQ、社区讨论及[官方 TTS 示例仓库](https://gitee.com/harmonyos_samples/core-speech-kit-sample-code-ark-ts-kit-ttsdemo)，并对照已安装 API 26 SDK。官方当前网页正文读取受动态页面限制，接口依据同时核对 DevEco CLI 本地官方原文；在线检索可读的 API 13 `onComplete` 章节也明确提示音频回调可能尚未返回完。示例仓库 README 可读，但源码文件访问失败，未将其视为已核验的实现。

系统合成结束后保留请求，收到新包则重新等待 300 ms 静默窗口；没有非空音频时保留 1500 ms 首包宽限，缺号或持续收包最多等待 5000 ms。合法空包保留序号，全空、重复序号及缺号超时不能当作朗读成功。SDK 没有末包标记或最终包数，上述时间窗口是应用策略，无法证明窗口之后绝不会有新包。单请求合成缓冲上限为 4 MiB，超限停止并报错，不截断音频后继续。

在生产播放器代码的定向回归中，已复现：调用方处理写入失败后，内部聚合 Promise 仍产生未处理拒绝。修复保留 `write` 和 `drain` 的原错误传播，同时立即观察内部聚合的拒绝。该结果证明错误传播缺陷存在，不能替代设备崩溃日志，也不能确认它就是本次闪退的全部原因。

PCM 输出回归以 16 kHz、440 Hz 合成采样验证跨段写入，输出采样与输入一致，尾部仅补零；该检查不覆盖系统合成的实际发音、设备音频路由和听感。首次修复时 HDC 未连接设备，聆小珊的实际语速、语调、长章节及锁屏连播未完成真机验收。

2026-10-13 本地验证：系统朗读 27 组行为回归、PCM 输出 2 组定向检查，以及 `local-features-check.mjs`、`theme-framework-check.mjs`、`thread-blocking-check.mjs`、`neutral-source-engine-check.mjs`、`git diff --check` 均通过。`devecocli build --modules entry --product default` 输出 `BUILD SUCCESSFUL`，重新生成 `entry/build/default/outputs/default/entry-default-signed.hap`。构建包含当前工作区既有改动，仍有项目弃用与版本兼容警告；未执行独立 lint 或真机验收。

### 长章节冻屏报告

设备：HUAWEI Pura X View，HarmonyOS `7.0.0.109(SP10C00E100R5P6)`；应用 `3.10.908`。用户操作复现后，保存的 `output/device-logs/tts-20261013-095809/hilog.log` 显示：09:58:49 上报 `THREAD_BLOCK_3S`，09:58:52 上报 `THREAD_BLOCK_6S`，09:58:56 系统以该原因强制结束应用进程。此前分页日志记录章节长度 101244 字符。

设备的 `/data/log/faultlog/faultlogger` 目录禁止直接读取，但通过 `devecocli log --device 192.168.137.35:42347 --crash --bundle-name io.legado.read` 成功取得完整报告，保存为同目录 `freeze-report.txt`。3 秒及 6 秒的主线程栈均位于 `SystemTtsReader.start → splitSystemText → findLastCloudBreak/findFirstCloudBreak → isCloudBreak`；采样栈还直接指向 `safeHardCutIndex`。这次退出发生在文本分块阶段，系统语音引擎尚未开始合成。

`safeHardCutIndex` 为保持英文和数字词完整，会把切点向前移，但原实现只以章节位置 1 为下界。连续 ASCII 词超过当前块长度时，切点可退回当前块起点或更早，随后 `start = end` 无法前进，形成同步死循环并触发系统冻屏检测。修复须以当前块起点限制回退；无法保留超长词整体时，在不拆开 UTF-16 代理对的前提下强制安全切分，同时保持正文偏移和内容完整。

本次设备复测应先重试用户原来的 101244 字符章节，选择聆小珊、1.0x，从相同位置开始；再分别覆盖超过 60 字符的连续英文、数字及无标点长网址。需要观察语音开始、页面仍可响应暂停/停止，以及同一进程不再出现 `THREAD_BLOCK_3S/6S`。这些设备表现须独立于 Node 分块回归和 HAP 构建记录。

修复后的本地验证：分块回归 48 组、系统朗读回归 27 组、PCM 输出 2 组、主线程阻塞检查及差异检查通过；构建输出 `BUILD SUCCESSFUL`。在指定设备执行 `hdc install -r` 成功更新调试包，保留应用数据；尚待用户操作同一章节确认实际表现。修改前通过生产代码 VM 执行时限复现系统及云端长词分块受控超时，修改后全部完成；101244 字符的连续英文和数字也完成分块，验证了正文完整及偏移严格前进。

### PCM 通道复核

用户安装分块修复后确认“不闪退，但依然系统音频无效”。持续日志保存于 `output/device-logs/tts-retest-20261013-101405/hilog.log`。内部异常为“PCM音频包含不完整采样帧”；追加失败参数日志后，设备实际返回 `rate=16000,bits=16,channel=3,type=pcm,bytes=290240`，分片序号从 0 至 22 完整，重复操作结果一致。

290240 字节符合完整的 16 位单声道采样长度，但不符合三个声道的帧长度。原调用设置 `soundChannel: 3`，应用将回传的 `audioChannel: 3` 作为物理声道数。该设备表现与官方指南中的单声道 PCM 示例不一致；按三个声道缩混还会将能整除的音频长度缩短至约三分之一，解释此前的试听速度和音调异常。

修复将 `playType: 0` 的合成通道设为 1，使回传通道与应用内单声道 PCM 播放器一致；直接播报仍设为 3，保留息屏通道规则。未删掉帧完整性检查，也未将截断音频当作成功。新增以真机 290240 字节长度为依据的回归，验证设备回传输入通道时保留全部单声道采样；系统朗读回归增至 28 组，分块 48 组和 PCM 输出 2 组通过，构建成功并更新到指定设备，实际播放待用户复测。

通道修复后的设备日志：10:20:17、10:20:53、10:20:55 的朗读启动均返回 `rate=16000,bits=16,channel=1,type=pcm`；应用主进程 PID 20004 持续存在，未出现此前的帧长度错误。用户已明确确认分块修复后不再闪退；声音播放和听感的最终结论仍需用户反馈，锁屏和跨章长时间验收未完成。

本轮最终设备反馈：用户确认正常播放，语速和音调正常。随后提出中英文以外文本的发音表现，只要求查阅官方文档，未要求修改语言处理。日志采集已结束；本轮闪退、音频无效及异常听感完成用户复测，锁屏与跨章长时间验收仍未执行。官方《文本转语音》开发实例本身也对 `playType: 0` 设置 `soundChannel: 1`，与本次修复一致。

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
