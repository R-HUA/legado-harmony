import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { MembershipError } from './membershipPolicy.js';

const MAX_AVATAR_INPUT_BYTES = 256 * 1024;
const MAX_AVATAR_PIXELS = 16 * 1024 * 1024;
const AVATAR_EDGE_PIXELS = 1024;
export const MAX_ANIMATED_AVATAR_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_BODY_BYTES = Math.ceil(MAX_ANIMATED_AVATAR_BYTES / 3) * 4 + 4096;
const MAX_ANIMATED_PIXELS = 32 * 1024 * 1024;

export interface AvatarCrop { left: number; top: number; size: number; }
export interface SanitizedAvatar { data: Buffer; mime: 'image/jpeg' | 'image/gif'; }

export class InvalidAvatarError extends Error {}
export class AnimatedAvatarMembershipError extends MembershipError {
  constructor() { super(403, 'ANIMATED_AVATAR_MEMBERSHIP_REQUIRED', '动态头像仅限有效的终身会员和终身超级会员使用'); }
}

export async function sanitizeAvatarBase64(value: string): Promise<Buffer> {
  return (await prepareAvatarBase64(value, false)).data;
}

export async function prepareAvatarBase64(value: string, allowAnimated: boolean,
  crop?: AvatarCrop | null): Promise<SanitizedAvatar> {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_ANIMATED_AVATAR_BYTES / 3) * 4) {
    throw new InvalidAvatarError('动态头像大小不能超过 2MB');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new InvalidAvatarError('头像数据格式无效');
  }
  const input = Buffer.from(value, 'base64');
  if (!input.length || input.length > MAX_ANIMATED_AVATAR_BYTES) {
    throw new InvalidAvatarError('动态头像大小不能超过 2MB');
  }
  try {
    const image = sharp(input, {
      failOn: 'error',
      limitInputPixels: MAX_AVATAR_PIXELS,
      sequentialRead: true
    });
    const metadata = await image.metadata();
    if (
      !metadata.width
      || !metadata.height
      || metadata.width * metadata.height > MAX_AVATAR_PIXELS
      || !new Set(['jpeg', 'png', 'webp', 'gif']).has(metadata.format || '')
    ) {
      throw new InvalidAvatarError('头像图片格式或尺寸无效');
    }
    const frames = metadata.pages ?? 1;
    if (frames > 1) {
      if (!allowAnimated) throw new AnimatedAvatarMembershipError();
      const height = metadata.pageHeight ?? metadata.height;
      if (!['gif', 'webp'].includes(metadata.format!) || frames > 120 ||
          metadata.width > 1024 || height > 1024 || metadata.width * height * frames > MAX_ANIMATED_PIXELS) {
        throw new InvalidAvatarError('动态头像最多 120 帧、单帧不超过 1024×1024，累计像素不超过 32MP');
      }
      const size = crop?.size ?? Math.min(metadata.width, height);
      const left = crop?.left ?? Math.floor((metadata.width - size) / 2);
      const top = crop?.top ?? Math.floor((height - size) / 2);
      if (![size, left, top].every(Number.isSafeInteger) || size <= 0 || left < 0 || top < 0 ||
          left + size > metadata.width || top + size > height) {
        throw new InvalidAvatarError('头像裁剪区域无效');
      }
      const output = await sharp(input, { animated: true, limitInputPixels: MAX_ANIMATED_PIXELS })
        .extract({ left, top, width: size, height: size })
        .resize(256, 256)
        .gif({ effort: 3, colours: 128 })
        .timeout({ seconds: 10 })
        .toBuffer();
      if (!output.length || output.length > 1024 * 1024) {
        throw new InvalidAvatarError('动态头像处理后超过 1MB，请减少帧数或简化画面');
      }
      return { data: output, mime: 'image/gif' };
    }
    if (input.length > MAX_AVATAR_INPUT_BYTES) throw new InvalidAvatarError('静态头像大小不能超过 256KB');
    const output = await image
      .rotate()
      .resize({
        width: AVATAR_EDGE_PIXELS,
        height: AVATAR_EDGE_PIXELS,
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
    if (!output.length || output.length > MAX_AVATAR_INPUT_BYTES) {
      throw new InvalidAvatarError('头像处理后仍然过大');
    }
    return { data: output, mime: 'image/jpeg' };
  } catch (error) {
    if (error instanceof InvalidAvatarError || error instanceof AnimatedAvatarMembershipError) throw error;
    throw new InvalidAvatarError('头像不是有效的 JPEG、PNG、WebP 或 GIF 图片，或图片处理超时');
  }
}

/** A revoked entitlement keeps the avatar, but only its first frame is served. */
export async function staticAvatarFrame(data: Buffer): Promise<Buffer> {
  return sharp(data, { pages: 1, limitInputPixels: MAX_ANIMATED_PIXELS })
    .resize(256, 256, { fit: 'cover' }).jpeg({ quality: 86 }).timeout({ seconds: 5 }).toBuffer();
}
