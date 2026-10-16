import { webview } from '@kit.ArkWeb';
import { WebBookFetchRuntime } from '../core/book/WebBookFetchRuntime';

/** Invisible ArkWeb transport for source rules that explicitly opt into `webView: true`. */
@Component
export struct WebBookFetchRuntimeHost {
  private controller: webview.WebviewController = new webview.WebviewController();
  private attachRetryId: number = -1;
  private disappearing: boolean = false;

  aboutToAppear(): void {
    this.disappearing = false;
    this.scheduleAttachFallback(0);
  }

  aboutToDisappear(): void {
    this.disappearing = true;
    if (this.attachRetryId >= 0) clearTimeout(this.attachRetryId);
    this.attachRetryId = -1;
    WebBookFetchRuntime.get().detach(this.controller);
  }

  private attachRuntime(): void {
    if (this.disappearing) return;
    if (this.attachRetryId >= 0) clearTimeout(this.attachRetryId);
    this.attachRetryId = -1;
    WebBookFetchRuntime.get().attach(this.controller);
  }

  private scheduleAttachFallback(attempt: number): void {
    if (this.disappearing) return;
    this.attachRetryId = setTimeout((): void => {
      if (this.disappearing) return;
      try {
        // A successful getWebId proves the controller is associated with a Web component. On
        // some routed/hidden Web nodes ArkWeb omits onControllerAttached, so use this as fallback.
        this.controller.getWebId();
        this.attachRuntime();
        return;
      } catch (_) {}
      if (attempt < 100) this.scheduleAttachFallback(attempt + 1);
    }, attempt === 0 ? 0 : 100);
  }

  build() {
    // 传输层必须按正常桌面视口渲染：书源的正文净化要在页面里测量段落盒（getBoundingClientRect），
    // 1×1vp 的视口会让正文容器塌缩，净化脚本会按设计拒绝保存未过滤正文。
    // 因此这里铺满父容器，但保持不可见、不参与交互、不覆盖界面：
    // 1% 不透明度（父页面自身背景在其之上）、hitTestBehavior(None) 让触摸/滑动继续落到界面、
    // zIndex(-1) 保证任何情况下都不会盖住 UI。position 固定在左上角，避免继承父 Stack 的对齐方式。
    Web({ src: 'about:blank', controller: this.controller })
      .width('100%')
      .height('100%')
      .position({ x: 0, y: 0 })
      .zIndex(-1)
      .opacity(0.01)
      .hitTestBehavior(HitTestMode.None)
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .mixedMode(MixedMode.All)
      .onlineImageAccess(true)
      .onControllerAttached((): void => { this.attachRuntime(); })
      // 从其它页面返回时本页的 Web 组件不会再次触发 onControllerAttached，但抓取环境必须切回
      // 当前可见的这个宿主，否则共享运行时会继续停留在已经隐藏的旧宿主上（旧宿主退出后更会
      // 直接变成“未挂载”）。可见性变化是最可靠的“这个页面又回到前台”信号。
      .onVisibleAreaChange([0.0, 1.0], (isVisible: boolean, _ratio: number): void => {
        if (isVisible) this.attachRuntime();
      })
      .onPageBegin((): void => { WebBookFetchRuntime.get().onPageBegin(this.controller); })
      .onPageEnd((): void => { WebBookFetchRuntime.get().onPageEnd(this.controller); })
  }
}
