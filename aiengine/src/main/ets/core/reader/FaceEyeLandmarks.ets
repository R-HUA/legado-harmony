/*
 * 眼动翻页人脸关键点检测：本构建不包含上游专有推理模型与引擎，仅保留 GPL-3.0 开源兼容桩。
 * create() 返回 null 时，EyeTurnController 会自动回退到基础版眼动翻页。
 */
import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';

export class FaceEyeMetrics {
  presence: number = 0;
  eyes: number = 0;
  irisOffset: number = 0;
  openness: number = 0;
  lidRatio: number = 0;
}

export class FaceEyeSample {
  metrics: FaceEyeMetrics = new FaceEyeMetrics();
  rotation: number = 0;
  locked: boolean = false;
  cropMs: number = 0;
  prepMs: number = 0;
  inferMs: number = 0;
  backend: string = 'none';
}

export class FaceEyeLandmarks {
  static async create(_context: common.Context): Promise<FaceEyeLandmarks | null> {
    return null;
  }

  async estimate(_pixelMap: image.PixelMap, _left: number, _top: number,
    _width: number, _height: number): Promise<FaceEyeSample | null> {
    return null;
  }
}
