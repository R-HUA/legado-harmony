import { webview } from '@kit.ArkWeb';
import { util } from '@kit.ArkTS';
import { CookieStore } from '../http/CookieStore';

export interface WebBookFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  webJs?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface WebBookFetchResponse {
  url: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  success: boolean;
  error?: string;
}

class WebBookFetchTask {
  request: WebBookFetchRequest = { url: '', method: 'GET', headers: {} };
  resolve: ((value: WebBookFetchResponse) => void) | null = null;
  timeoutId: number = -1;
  inspectId: number = -1;
  stableCount: number = 0;
  lastSignature: string = '';
  pageEnded: boolean = false;
}

/** One mounted hidden host plus the User-Agent state the runtime installed on its controller. */
class WebBookFetchHost {
  controller: webview.WebviewController;
  appliedUserAgent: string = '';
  defaultUserAgentValue: string = '';

  constructor(controller: webview.WebviewController, defaultUserAgentValue: string) {
    this.controller = controller;
    this.defaultUserAgentValue = defaultUserAgentValue;
  }
}

/**
 * Browser-backed transport for rules that explicitly declare `webView: true`.
 * It only opens source-owned URLs, executes normal page JavaScript and returns the
 * resulting DOM (or source-owned webJs output); it contains no site-specific rules.
 */
export class WebBookFetchRuntime {
  private static instance: WebBookFetchRuntime | null = null;
  private controller: webview.WebviewController | null = null;
  private ready: boolean = false;
  private active: WebBookFetchTask | null = null;
  private queue: WebBookFetchTask[] = [];
  /** UA currently installed on the shared controller, so it is only changed when it must be. */
  private appliedUserAgent: string = '';
  private defaultUserAgentValue: string = '';
  /**
   * Every mounted hidden host, most recently used last. A routed page keeps its own Web component
   * alive underneath the page that is currently on top, so the runtime must remember all of them:
   * when the top page's host disappears, the still-mounted host of the page below has to take over
   * instead of leaving the transport unattached — that left the next search with a detached
   * controller and the "WebView 抓取环境未挂载" failure even though a host was still on screen.
   */
  private hosts: WebBookFetchHost[] = [];

  static get(): WebBookFetchRuntime {
    if (!WebBookFetchRuntime.instance) WebBookFetchRuntime.instance = new WebBookFetchRuntime();
    return WebBookFetchRuntime.instance;
  }

  attach(controller: webview.WebviewController): void {
    const known = this.findHost(controller);
    const host = known ? known : new WebBookFetchHost(controller, this.readControllerUserAgent(controller));
    if (known) {
      this.hosts = this.hosts.filter((item: WebBookFetchHost): boolean => item !== host);
    }
    // onControllerAttached means loadUrl/postUrl are already usable. Waiting for the initial
    // about:blank onPageEnd introduces a cold-start race and is unnecessary for this transport.
    // A controller's own User-Agent is read strictly before any custom UA is installed on it.
    this.hosts.push(host);
    if (this.controller === controller) {
      this.adoptHost(host);
      this.ready = true;
      this.recoverIdleController();
      this.runNext();
      return;
    }
    // A routed page can attach its host before the previous page has disappeared. Preserve the
    // in-flight request and restart it on the new controller; failing it here creates a race where
    // a detail request submitted by aboutToAppear is cancelled by that very detail page's host.
    this.suspendActiveForMigration();
    this.controller = controller;
    this.adoptHost(host);
    this.ready = true;
    this.runNext();
  }

  detach(controller: webview.WebviewController): void {
    this.hosts = this.hosts.filter((host: WebBookFetchHost): boolean => host.controller !== controller);
    if (this.controller !== controller) return;
    const fallback = this.hosts.length > 0 ? this.hosts[this.hosts.length - 1] : null;
    if (fallback) {
      // The page that owned this controller is gone, but another hidden host is still mounted:
      // continue on it rather than reporting the transport as closed.
      console.info(`[WebBookFetch] 宿主页面已退出，改用仍挂载的隐藏宿主（剩余 ${this.hosts.length} 个）`);
      this.suspendActiveForMigration();
      this.controller = fallback.controller;
      this.adoptHost(fallback);
      this.ready = true;
      this.runNext();
      return;
    }
    if (this.active) this.finishActive(this.failure(this.active.request.url, '网页抓取环境已关闭'));
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task?.resolve) task.resolve(this.failure(task.request.url, '网页抓取环境已关闭'));
    }
    this.controller = null;
    this.ready = false;
  }

  private findHost(controller: webview.WebviewController): WebBookFetchHost | null {
    for (const host of this.hosts) {
      if (host.controller === controller) return host;
    }
    return null;
  }

  private adoptHost(host: WebBookFetchHost): void {
    this.appliedUserAgent = host.appliedUserAgent;
    this.defaultUserAgentValue = host.defaultUserAgentValue;
  }

  /** Moves the in-flight task back into the queue so the next host restarts it from scratch. */
  private suspendActiveForMigration(): void {
    const task = this.active;
    if (!task) return;
    if (task.timeoutId >= 0) clearTimeout(task.timeoutId);
    if (task.inspectId >= 0) clearTimeout(task.inspectId);
    task.timeoutId = -1;
    task.inspectId = -1;
    task.pageEnded = false;
    task.stableCount = 0;
    task.lastSignature = '';
    this.active = null;
    this.queue.unshift(task);
  }

  setReady(ready: boolean, controller: webview.WebviewController): void {
    if (this.controller !== controller) return;
    this.ready = ready;
    if (ready) this.runNext();
  }

  onPageBegin(controller: webview.WebviewController): void {
    if (this.controller !== controller || !this.active) return;
    this.active.pageEnded = false;
    this.active.stableCount = 0;
    this.active.lastSignature = '';
  }

  onPageEnd(controller: webview.WebviewController): void {
    if (this.controller !== controller) return;
    if (!this.active) {
      this.ready = true;
      this.runNext();
      return;
    }
    this.active.pageEnded = true;
    this.scheduleInspect(this.active, 250);
  }

  isAvailable(): boolean { return !!this.controller && this.ready; }

  isAttached(): boolean { return !!this.controller; }

  async waitUntilAttached(timeoutMs: number = 8000): Promise<boolean> {
    if (this.isAttached()) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < Math.max(100, timeoutMs)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      if (this.isAttached()) return true;
    }
    if (!this.isAttached()) {
      console.warn(`[WebBookFetch] 等待隐藏宿主超时：已注册 ${this.hosts.length} 个，` +
        `当前页面是否挂载了 WebBookFetchRuntimeHost`);
    }
    return this.isAttached();
  }

  async waitUntilAvailable(timeoutMs: number = 2500): Promise<boolean> {
    this.recoverIdleController();
    if (this.isAvailable()) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < Math.max(100, timeoutMs)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      this.recoverIdleController();
      if (this.isAvailable()) return true;
    }
    this.recoverIdleController();
    return this.isAvailable();
  }

  fetch(request: WebBookFetchRequest): Promise<WebBookFetchResponse> {
    return new Promise<WebBookFetchResponse>((resolve) => {
      const url = String(request.url || '').trim();
      const method = String(request.method || 'GET').toUpperCase();
      if (!/^https?:\/\//i.test(url)) {
        resolve(this.failure(url, 'WebView 仅支持 http/https 地址'));
        return;
      }
      if (method !== 'GET' && method !== 'POST') {
        resolve(this.failure(url, `WebView 暂不支持 ${method} 请求`));
        return;
      }
      if (this.queue.length >= 32) {
        resolve(this.failure(url, '网页抓取任务过多，请稍后重试'));
        return;
      }
      const task = new WebBookFetchTask();
      task.request = request;
      task.resolve = resolve;
      this.queue.push(task);
      this.recoverIdleController();
      this.runNext();
    });
  }

  private recoverIdleController(): void {
    if (!this.controller || this.active || this.ready) return;
    // Returning to about:blank normally restores ready in onPageEnd. Some ArkWeb lifecycle
    // transitions omit that callback; an attached controller with no active task is safe to reuse.
    this.ready = true;
    this.runNext();
  }

  private runNext(): void {
    if (this.active || !this.controller || !this.ready || this.queue.length === 0) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    this.ready = false;
    const timeoutMs = Math.max(3000, Math.min(60000, task.request.timeoutMs || 20000));
    task.timeoutId = setTimeout((): void => {
      if (this.active === task) {
        this.finishActive(this.failure(task.request.url, `WebView 请求超时（${timeoutMs}ms）`));
      }
    }, timeoutMs);
    try {
      // A custom UA set for one source would otherwise leak into every later `webView` request on
      // this shared controller, including sources that never declared a User-Agent header and would
      // be served a different (for example mobile or desktop) theme because of the leftover value.
      this.applyUserAgent(this.headerValue(task.request.headers, 'user-agent'));
      const cookie = this.headerValue(task.request.headers, 'cookie');
      if (cookie) CookieStore.setCookies(task.request.url, cookie);
      if (String(task.request.method || 'GET').toUpperCase() === 'POST') {
        const bytes = new util.TextEncoder().encodeInto(task.request.body || '');
        this.controller.postUrl(task.request.url, bytes.buffer as ArrayBuffer);
      } else {
        this.controller.loadUrl(task.request.url, this.webHeaders(task.request.headers));
      }
    } catch (error) {
      this.finishActive(this.failure(task.request.url, this.errorMessage(error as Object)));
    }
  }

  /**
   * Applies the request's User-Agent, or restores the value the controller had before this runtime
   * touched it when the request declares none. Without this a desktop UA installed for one source
   * would leak into every later `webView` request on the shared controller, and sources that never
   * declared a UA would suddenly be served a different theme.
   */
  private applyUserAgent(userAgent: string): void {
    const controller = this.controller;
    if (!controller) return;
    const wanted = userAgent || this.defaultUserAgentValue;
    if (!wanted || wanted === this.appliedUserAgent) return;
    try {
      controller.setCustomUserAgent(wanted);
      this.appliedUserAgent = wanted;
      const host = this.findHost(controller);
      if (host) host.appliedUserAgent = wanted;
    } catch (error) {
      console.warn('[WebBookFetch] setCustomUserAgent failed:', this.errorMessage(error as Object));
    }
  }

  private readControllerUserAgent(controller: webview.WebviewController): string {
    try {
      // Read on attach, strictly before any custom UA is installed on this controller, so the
      // captured value is the ArkWeb platform default rather than some other source's UA.
      return controller.getUserAgent() || '';
    } catch (error) {
      console.warn('[WebBookFetch] getUserAgent unavailable:', this.errorMessage(error as Object));
      return '';
    }
  }

  private scheduleInspect(task: WebBookFetchTask, delayMs: number): void {
    if (this.active !== task) return;
    if (task.inspectId >= 0) clearTimeout(task.inspectId);
    task.inspectId = setTimeout((): void => this.inspect(task), delayMs);
  }

  private inspect(task: WebBookFetchTask): void {
    const controller = this.controller;
    if (this.active !== task || !controller || !task.pageEnded) return;
    const script = `(function(){return JSON.stringify({url:String(location.href||''),title:String(document.title||''),` +
      `ready:String(document.readyState||''),html:String(document.documentElement?document.documentElement.outerHTML:'')})})()`;
    controller.runJavaScript(script).then((raw: string): void => {
      if (this.active !== task) return;
      const snapshot = this.parseSnapshot(raw);
      if (!snapshot || !snapshot['html']) {
        this.scheduleInspect(task, 400);
        return;
      }
      const html = snapshot['html'];
      const snapshotUrl = String(snapshot['url'] || '').trim();
      // A newly attached routed-page host first completes its own about:blank navigation. That
      // callback can arrive after the pending request has migrated to it; never mistake the
      // 39-byte empty document for the requested source response.
      if (!/^https?:\/\//i.test(snapshotUrl)) {
        this.scheduleInspect(task, 400);
        return;
      }
      const maxBytes = task.request.maxResponseBytes || 0;
      if (maxBytes > 0 && this.utf8Length(html) > maxBytes) {
        this.finishActive(this.failure(snapshot['url'] || task.request.url, `response too large: >${maxBytes}`));
        return;
      }
      const signature = `${snapshot['url']}|${snapshot['title']}|${snapshot['ready']}|${html.length}|` +
        `${html.substring(0, 160)}|${html.substring(Math.max(0, html.length - 160))}`;
      task.stableCount = signature === task.lastSignature ? task.stableCount + 1 : 0;
      task.lastSignature = signature;
      if (task.stableCount < 2 || snapshot['ready'] !== 'complete') {
        this.scheduleInspect(task, 400);
        return;
      }
      this.resolveBody(task, snapshot['url'] || task.request.url, html);
    }).catch((error: Error): void => {
      if (this.active === task) this.finishActive(this.failure(task.request.url, this.errorMessage(error)));
    });
  }

  private resolveBody(task: WebBookFetchTask, finalUrl: string, html: string): void {
    const controller = this.controller;
    const webJs = String(task.request.webJs || '').trim();
    if (!controller || !webJs) {
      this.finishActive(this.success(finalUrl, html));
      return;
    }
    controller.runJavaScript(webJs).then((raw: string): void => {
      if (this.active !== task) return;
      const value = this.unwrapJavaScriptResult(raw);
      this.finishActive(this.success(finalUrl, value && value !== 'undefined' && value !== 'null' ? value : html));
    }).catch((error: Error): void => {
      if (this.active === task) {
        this.finishActive(this.failure(finalUrl, `webJs 执行失败: ${this.errorMessage(error)}`));
      }
    });
  }

  private finishActive(response: WebBookFetchResponse): void {
    const task = this.active;
    if (!task) return;
    this.active = null;
    if (task.timeoutId >= 0) clearTimeout(task.timeoutId);
    if (task.inspectId >= 0) clearTimeout(task.inspectId);
    if (task.resolve) task.resolve(response);
    try { this.controller?.stop(); } catch (_) {}
    try { this.controller?.loadUrl('about:blank'); } catch (_) {}
    setTimeout((): void => this.runNext(), 0);
  }

  private webHeaders(source: Record<string, string>): webview.WebHeader[] {
    const result: webview.WebHeader[] = [];
    for (const key of Object.keys(source || {})) {
      const normalized = key.toLowerCase();
      if (normalized === 'user-agent' || normalized === 'cookie' || normalized === 'connection' ||
        normalized === 'host' || normalized === 'content-length') continue;
      result.push({ headerKey: key, headerValue: String(source[key] || '') });
    }
    return result;
  }

  private headerValue(headers: Record<string, string>, name: string): string {
    for (const key of Object.keys(headers || {})) {
      if (key.toLowerCase() === name) return String(headers[key] || '');
    }
    return '';
  }

  private parseSnapshot(raw: string): Record<string, string> | null {
    try { return JSON.parse(this.unwrapJavaScriptResult(raw)) as Record<string, string>; } catch (_) { return null; }
  }

  private unwrapJavaScriptResult(raw: string): string {
    const value = String(raw || '');
    if (value.startsWith('"') && value.endsWith('"')) {
      try { return String(JSON.parse(value)); } catch (_) {}
    }
    return value;
  }

  private utf8Length(value: string): number {
    let length = 0;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x80) length += 1;
      else if (code < 0x800) length += 2;
      else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length) { length += 4; i++; }
      else length += 3;
    }
    return length;
  }

  private success(url: string, body: string): WebBookFetchResponse {
    return { url: url, statusCode: 200, headers: {}, body: body, success: true };
  }

  private failure(url: string, error: string): WebBookFetchResponse {
    return { url: url, statusCode: 0, headers: {}, body: '', success: false, error: error };
  }

  private errorMessage(error: Object): string {
    return error instanceof Error ? error.message : String(error || 'unknown error');
  }
}
