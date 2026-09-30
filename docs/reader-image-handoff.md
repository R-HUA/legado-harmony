# 阅读器图片页翻页交接

2026-09-30，HarmonyOS 目标 SDK 26、兼容 API 12，Pura X View 真机。

## 问题与修复

含图片标记的章节使用传统 ArkUI 正文树。其页码/渲染身份变化会重建整页，包括 Image；预览和正式页原来分别从 URI 加载图片。动画收尾只延时 16ms（跨章48ms），没有图片解码完成检查。后台分页完成时 `applyReaderPaginationResult → setCurrentPageText` 同样会更新渲染身份。因此即使预览页已显示插图，正式页仍可能短暂露出背景。

`ReaderPagedImageCache` 将网络读取与解码异步提前执行，预览、当前页和分页更新后的组件共同持有同一份 PixelMap。组件初次挂载可直接获取缓存像素；`syncLoad(true)` 仅用于已解码的 PixelMap，网络 URI 回退继续异步加载。解码按视口等比缩小，不拉伸原图。GIF/动态 WebP 检测多帧后保留原 URI 渲染，不变成静态首帧。

阅读器只预取相邻前后页/双页。动画截图和交接先有限等待共享解码，再检查 Image 的 `loadingStatus === 1`，最后给布局/绘制留时间。等待超时会继续，失败显示占位，不永久锁住翻页。无动画的同章翻页也提前准备目标图片。

缓存使用最多两个下载/解码槽位，按 LRU 清理至6项/24MiB；仍被挂载组件或交接持有的像素不可释放，故活跃资源可临时超过缓存清理目标。最后一个租约释放后再清理，PixelMap 延迟80ms释放以避开正在提交的渲染帧。组件销毁后不会接收迟到解码结果。解码/网络失败短时间内去重，不重复请求风暴。

## 依据

- [华为：图片白块优化](https://developer.huawei.com/consumer/en/doc/best-practices/bpta-image-white-lump-solution)：网络下载与解码在组件显示前预加载，可转为 PixelMap复用。
- 本机 SDK `ets/component/image.d.ts`：`loadingStatus=0` 是数据加载完成，`1` 才是解码完成；同步加载 URI 会阻塞主线程。
- 本机 SDK `ets/api/@ohos.multimedia.image.d.ts`：异步 ImageSource 解码、按 desiredSize 降采样、getFrameCount、PixelMap 释放。

## 验证与边界

- `node scripts/reader-paged-image-check.mjs`：运行生产缓存代码，替换平台 ImageSource/HTTP。验证请求合并、PixelMap同步复用、比例保持、活跃租约保护、LRU及字节目标、两并发槽、失败与动图回退。
- `node scripts/thread-blocking-check.mjs` 通过。
- `devecocli build --modules entry --product default` 构建通过；覆盖安装后用户反复前后翻同一张轻之国度插图，反馈“不再闪白”。截图核对当前12/382页插图正常。
- 修复前录屏 `SVID_20260930_174628_1.mp4`：保留原始帧时间解出158帧。用户补充三张播放器截图后，重新检查连续帧，确认第86帧（文件`0085.jpg`，从0编号）正文区只剩浅色主题背景，前后两帧插图均正常。空白帧页码已为12/19，而此前预览仍为11/19，与动画预览交接给新正式页的时序吻合。视频能证实交接时图片曾消失；确切内部调用仍由代码分析推断。
- 首次录像检查漏检原因：缩略图总览仅选取部分帧，亮白检测又要求所有RGB通道>240，浅米色主题背景不满足条件，因此未选中第86帧。这是分析方法漏检，不是录像没有记录。后续检查应同时看正文区纹理/对比度骤降及连续相邻帧，不能仅按纯白比例筛选。录像后来也有19→382总页数更新，但闪空发生在12/19阶段，不能把总页数变化当作此次闪空的直接证据。
- 本次没有修复后录像；消除闪白的验收依据是真机用户复测，静态截图不能证明动画连续性。动图、双页和所有翻页模式未全部在真机逐帧验证。
