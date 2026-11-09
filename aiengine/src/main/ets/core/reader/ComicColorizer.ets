/*
 * 漫画 AI 着色：本构建不包含（上游着色模型与 worker 不在 GPL 公开版本的合入范围内）。
 * 这里只保留上游调用方用到的 API 形状，全部报告“不支持”，界面据此隐藏/禁用着色入口。
 */
import { common } from '@kit.AbilityKit';

export class ComicColorResult {
  uri: string = '';
  elapsedMs: number = 0;
  inferenceMs: number = 0;
  cached: boolean = false;
  backend: string = '';
}

export class ComicColorizer {
  static readonly CANCELLED: string = '漫画着色已取消';
  static readonly UNSUPPORTED: string = '本构建不包含漫画 AI 着色';
  private static foreground: boolean = true;

  static supported(): boolean {
    return false;
  }

  static memberAllowed(): boolean {
    return false;
  }

  static async colorize(_context: common.Context, _source: string, active: () => boolean,
    _status?: (status: string) => void): Promise<ComicColorResult> {
    if (!active()) throw new Error(ComicColorizer.CANCELLED);
    throw new Error(ComicColorizer.UNSUPPORTED);
  }

  static async prepare(_context: common.Context, _active: () => boolean): Promise<void> {
    throw new Error(ComicColorizer.UNSUPPORTED);
  }

  static releaseIdleWorker(): void {}

  static setAppForeground(foreground: boolean): void {
    ComicColorizer.foreground = foreground;
  }

  static isAppForeground(): boolean {
    return ComicColorizer.foreground;
  }

  static onMemoryPressure(_level?: number): void {}
}

/** 着色模型：本构建不下载、不携带任何模型。 */
export class ComicColorModels {
  static missingBytes(_context: common.Context): number {
    return 0;
  }

  static async download(_context: common.Context, _active: () => boolean, _progress: (status: string) => void,
    _onBytes?: (received: number, total: number) => void): Promise<void> {
    throw new Error(ComicColorizer.UNSUPPORTED);
  }
}
