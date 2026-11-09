import { webview } from '@kit.ArkWeb';
import { WebRuntimeAvailability } from '../utils/WebRuntimeAvailability';
import { WebBookFetchRuntime } from '@legado/sourceengine';

/** Invisible ArkWeb transport for source rules that explicitly opt into `webView: true`. */
@Component
export struct WebBookFetchRuntimeHost {
  private controller: webview.WebviewController = new webview.WebviewController();
  private attachRetryId: number = -1;
  private disappearing: boolean = false;
  private initialPageReady: boolean = false;
  private registered: boolean = false;

  aboutToAppear(): void {
    this.disappearing = false;
    this.initialPageReady = false;
    this.registered = false;
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
    this.registered = true;
    WebBookFetchRuntime.get().attach(this.controller);
  }

  private scheduleAttachFallback(attempt: number): void {
    if (this.disappearing) return;
    this.attachRetryId = setTimeout((): void => {
      if (this.disappearing) return;
      // Association alone is not enough on a cold ArkWeb: the component's initial src
      // navigation can overwrite the first loadUrl. Prefer its first onPageEnd. Some routed
      // hosts omit that event, so retain a bounded fallback after initialization has settled.
      if (!this.initialPageReady && attempt < 10) {
        this.scheduleAttachFallback(attempt + 1);
        return;
      }
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
    if (WebRuntimeAvailability.isAvailable()) {
      Web({ src: 'about:blank', controller: this.controller })
        .width('100%')
        .height('100%')
        .position({ x: 0, y: 0 })
        .zIndex(-1)
        .opacity(0.01)
        .hitTestBehavior(HitTestMode.None)
        .accessibilityLevel('no')
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .mixedMode(MixedMode.All)
        .onlineImageAccess(true)
        .onControllerAttached((): void => { this.scheduleAttachFallback(0); })
        .onVisibleAreaChange([0], (visible: boolean): void => {
          if (visible && !this.disappearing) this.scheduleAttachFallback(0);
        })
        .onPageBegin((event): void => { WebBookFetchRuntime.get().onPageBegin(this.controller, event?.url || ''); })
        .onPageEnd((event): void => {
          this.initialPageReady = true;
          if (!this.registered) this.attachRuntime();
          WebBookFetchRuntime.get().onPageEnd(this.controller, event?.url || '');
        })
    }
  }
}
