/*
 * 阅读页着色会话：本构建不着色，会话保持惰性（不调度、不产出结果），只保留上游调用方用到的 API。
 */
import { common } from '@kit.AbilityKit';
import { AiRuntime } from '../../runtime/AiRuntime';

export class ComicColorCandidate {
  source: string;
  visible: boolean;
  distance: number;
  label: string;

  constructor(source: string, visible: boolean, distance: number, label: string = '') {
    this.source = source;
    this.visible = visible;
    this.distance = distance;
    this.label = label;
  }
}

export class ReaderComicColorSession {
  foreground: boolean = false;

  /** 阅读器图片标记 → 图片地址（由宿主解析）。 */
  static source(marker: string): string {
    return AiRuntime.installed() ? AiRuntime.host().resolveImageSource(marker) : '';
  }

  configure(_context: common.Context, _book: string, _enabled: boolean): void {}

  setEnabled(_enabled: boolean): void {}

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
  }

  active(): boolean {
    return false;
  }

  single(_source: string): void {}

  subscribe(_listener: () => void): () => void {
    return (): void => {};
  }

  uri(_source: string): string {
    return '';
  }

  moving(): boolean {
    return false;
  }

  failed(_source: string): void {}

  update(_candidates: ComicColorCandidate[]): void {}

  touch(_down: boolean): void {}

  motion(): void {}

  clearCompare(): void {}

  processingVisible(): boolean {
    return false;
  }
}
