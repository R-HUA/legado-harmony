/*
 * 着色 worker 入口（上游 '@legado/aiengine/Worker'）。本构建不着色：worker 被创建时直接关闭自己。
 */
import { worker } from '@kit.ArkTS';

export function startComicColorWorker(): void {
  const port = worker.workerPort;
  port.onmessage = (): void => {
    port.postMessage({ error: '本构建不包含漫画 AI 着色' });
  };
  port.close();
}
