import { ReaderImageCache } from './ReaderImageCache';
import fs from '@ohos.file.fs';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { ReaderCacheBudget } from './ReaderCacheBudget';
import { BookSource, HttpClient, NativeSourceCrypto, SourceImageDecoder, NativeSourceSpec, NativeImageScriptRunner, digestHashHex } from '@legado/sourceengine';

export class ComicImageSpec {
  url: string = '';
  headers: Record<string, string> = {};
  hasOptions: boolean = false;
  /** 原生书源给出的解密参数；空串表示不解密。 */
  decodeAlgorithm: string = '';
  decodeKey: string = '';
  decodeIv: string = '';
  decodeIvPrefixBytes?: number;
  decodeScript: string = '';
  decodeParams: Object = {};
  processPlainImages: boolean = false;
  decodeError: string = '';
  /** 原生书源给每张图标的本章原始序号；-1 表示没有，用调用方给的序号。 */
  imageIndex: number = -1;
}

/** 单张正文图片各环节耗时（毫秒），用于排查整章图片加载慢。 */
export class ComicImageTiming {
  cacheHit: boolean = false;
  downloadMs: number = 0;
  /** 图片脚本耗时，包含排队等待全局脚本会话的时间。 */
  scriptMs: number = 0;
  decryptMs: number = 0;
}

/**
 * Request context a browser would use for a chapter's artwork: the chapter URL as `Referer` plus
 * the source's own non-secret request headers (User-Agent/Accept-Language/…).
 *
 * Sites behind a browser check (Cloudflare-style "Attention Required" for static files) reject a
 * plain image request even though the same URL renders inside the WebView session: the WebView
 * passes the challenge with the source's User-Agent and keeps the resulting cookies in the shared
 * jar. Native artwork requests must therefore repeat the same User-Agent + Referer; uploading them
 * through HTTP is what turns a 403 challenge page into real image bytes.
 */
export class ComicImageRequestContext {
  referer: string = '';
  headers: Record<string, string> = {};

  isEmpty(): boolean {
    return !this.referer && Object.keys(this.headers).length === 0;
  }
}

/**
 * Materializes protected comic images as app-owned cache files. Imported rules
 * never receive filesystem access; only bounded HTTP headers and allow-listed
 * symmetric decryption are exposed by this adapter.
 */
export class ComicImagePipeline {
  private static readonly MAX_IMAGE_BYTES: number = 20 * 1024 * 1024;

  static parse(raw: string): ComicImageSpec {
    const spec = new ComicImageSpec();
    const value = this.decodeEntities(raw || '').trim().replace(/^['"]|['"]$/g, '');
    if (!value) return spec;
    const optionIndex = this.findOptionIndex(value);
    spec.url = (optionIndex >= 0 ? value.substring(0, optionIndex) : value).trim();
    if (optionIndex < 0) return spec;
    const rawOptions = value.substring(optionIndex + 1).trim();
    try {
      const options = JSON.parse(rawOptions) as Record<string, Object>;
      const imageIndex = options['imageIndex'];
      if (typeof imageIndex === 'number' && Number.isInteger(imageIndex) && imageIndex >= 0) {
        spec.imageIndex = imageIndex;
      }
      const headerObject = options['headers'];
      if (headerObject && typeof headerObject === 'object' && !Array.isArray(headerObject)) {
        const record = headerObject as Record<string, Object>;
        for (const key in record) {
          const headerValue = String(record[key] || '').trim();
          if (this.allowedHeader(key) && headerValue && !/[\r\n\0]/.test(headerValue)) spec.headers[key] = headerValue;
        }
      }
      const decode = options['decode'];
      if (decode && typeof decode === 'object' && !Array.isArray(decode)) {
        const record = decode as Record<string, Object>;
        spec.decodeAlgorithm = String(record['algorithm'] || '');
        spec.decodeKey = String(record['key'] || '');
        spec.decodeIv = String(record['iv'] || '');
        if (record['ivPrefixBytes'] !== undefined) spec.decodeIvPrefixBytes = record['ivPrefixBytes'] as number;
        if (record['script'] !== undefined) {
          if (typeof record['script'] !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(record['script'] as string)) {
            spec.decodeError = 'content.imageDecode.script 必须是 JS 函数名';
          } else spec.decodeScript = record['script'] as string;
          const params = record['params'];
          if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params) || JSON.stringify(params).length > 16384)) {
            spec.decodeError = 'content.imageDecode.params 必须是最多 16384 字符的对象';
          } else spec.decodeParams = params || {};
          if (record['processPlainImages'] !== undefined && typeof record['processPlainImages'] !== 'boolean') {
            spec.decodeError = 'content.imageDecode.processPlainImages 必须是布尔值';
          }
          spec.processPlainImages = record['processPlainImages'] === true;
          if (spec.decodeAlgorithm || spec.decodeKey || spec.decodeIv || spec.decodeIvPrefixBytes !== undefined) {
            spec.decodeError = 'content.imageDecode.script 不能与标准解密字段混用';
          }
        }
      }
      spec.hasOptions = true;
    } catch (_) {
    }
    return spec;
  }

  /**
   * Builds the artwork request context for one chapter page. Only presentation headers travel with
   * it: the source's Cookie/Authorization values stay out of third-party image requests and the
   * shared cookie jar supplies whatever the visited hosts actually stored.
   *
   * A source that declares no browser headers at all keeps the direct-URI fast path, so ordinary
   * images are still loaded by the renderer instead of being downloaded twice.
   */
  static contextFromSource(source: BookSource, baseUrl: string): ComicImageRequestContext {
    const context = new ComicImageRequestContext();
    if (!source) return context;
    const headers = this.presentationHeaders(source);
    for (const key of Object.keys(headers)) context.headers[key] = headers[key];
    const parsed = this.parseStaticHeaders(source.header || '');
    const declaredReferer = this.lookupHeader(parsed, 'referer');
    // Only a source that really declares browser headers switches artwork to the app's HTTP stack;
    // an empty or unrelated header map must keep the renderer's direct-URI fast path.
    if (Object.keys(context.headers).length === 0 && !declaredReferer) return context;
    const pageReferer = /^https?:\/\//i.test(baseUrl || '') ? String(baseUrl).trim() : '';
    context.referer = pageReferer || declaredReferer;
    return context;
  }

  /**
   * The headers that decide how a request is identified: the source's own User-Agent and
   * Accept-Language. `Accept` is deliberately excluded — an image request keeps the image Accept
   * below, exactly like a browser loading an `<img>`.
   */
  static presentationHeaders(source: BookSource): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!source) return headers;
    const parsed = this.parseStaticHeaders(source.header || '');
    for (const key of Object.keys(parsed)) {
      if (!/^(?:user-agent|accept-language)$/i.test(key)) continue;
      const value = String(parsed[key] || '').trim();
      if (value) headers[key] = value;
    }
    return headers;
  }

  private static parseStaticHeaders(raw: string): Record<string, string> {
    const text = (raw || '').trim().replace(/[“”]/g, '"');
    if (!text || /^@?js\s*:/i.test(text)) return {};
    const headers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(text) as Record<string, Object>;
      for (const key of Object.keys(parsed)) {
        const value = parsed[key];
        if (value === undefined || value === null || typeof value === 'object') continue;
        headers[key] = String(value);
      }
      return headers;
    } catch (_) {
      // A source may still describe its headers as a loose literal map; read the plain pairs.
      const pairPattern = /["']?([A-Za-z0-9-]+)["']?\s*:\s*["']([^"']*)["']/g;
      let match: RegExpExecArray | null;
      while ((match = pairPattern.exec(text)) !== null) {
        if (match[1] && match[2]) headers[match[1]] = match[2];
      }
      return headers;
    }
  }

  private static lookupHeader(headers: Record<string, string>, name: string): string {
    const wanted = (name || '').toLowerCase();
    for (const key of Object.keys(headers || {})) {
      if (key.toLowerCase() === wanted) return String(headers[key] || '').trim();
    }
    return '';
  }

  /** Image request headers: image Accept, then the page's presentation headers, then the rule's own. */
  private static imageHeaders(ruleHeaders: Record<string, string>, contextHeaders: Record<string, string>,
    referer: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    };
    for (const key of Object.keys(contextHeaders)) {
      // The jar owns cookies; a source-level Cookie must never be replayed to an image host.
      if (/^cookie$/i.test(key) || !this.allowedHeader(key)) continue;
      headers[key] = contextHeaders[key];
    }
    if (referer) headers['Referer'] = referer;
    for (const key of Object.keys(ruleHeaders)) headers[key] = ruleHeaders[key];
    return headers;
  }

  static async materialize(http: HttpClient, source: BookSource, raw: string,
    forceLocal: boolean = false, cancelled: () => boolean = (): boolean => false, index: number = 0,
    timing: ComicImageTiming | null = null, context: ComicImageRequestContext | null = null): Promise<string> {
    if (cancelled()) throw new Error(HttpClient.CANCELLED_ERROR);
    const spec = this.parse(raw);
    if (spec.decodeError) throw new Error(spec.decodeError);
    // 逐张加载时调用方给的序号未必是图片在本章的原始位置，书源标了 imageIndex 就以它为准。
    const imageIndex = spec.imageIndex >= 0 ? spec.imageIndex : index;
    let scriptCode = '';
    let scriptConfig = '';
    if (spec.decodeScript) {
      const definition = NativeSourceSpec.unpack(source.jsLib || '');
      const decode = definition?.content?.imageDecode;
      if (!decode || decode.script?.trim() !== spec.decodeScript || !definition?.js) {
        throw new Error('content.imageDecode.script 与当前书源定义不一致，请重新加载正文');
      }
      const errors = NativeSourceSpec.validate(definition);
      if (errors.length) throw new Error(errors.join('; '));
      if ((decode.processPlainImages === true) !== spec.processPlainImages) {
        throw new Error('content.imageDecode.processPlainImages 已变更，请重新加载正文');
      }
      scriptCode = definition.js;
      scriptConfig = JSON.stringify(decode);
    }
    if (spec.decodeIvPrefixBytes !== undefined && (spec.decodeIvPrefixBytes !== 16 || spec.decodeIv ||
      !/^AES\/CBC\/PKCS(?:5|7)Padding$/i.test(spec.decodeAlgorithm))) {
      throw new Error('正文图片解密配置无效：ivPrefixBytes 必须为 16，使用 AES-CBC 且不能同时设置 iv');
    }
    // data: 内嵌图片也落成缓存文件：正文里不必带着几十上百 KB 的 Base64，解密配置对它同样生效。
    const embedded = this.dataImageBytes(spec.url);
    if (!embedded && !/^https?:\/\//i.test(spec.url)) return spec.url || raw;
    const decodeRule = source.contentRule?.imageDecode || '';
    const contextHeaders: Record<string, string> = context ? context.headers : {};
    const referer = context ? String(context.referer || '').trim() : '';
    // Sources that declare their own browser headers need the same headers for artwork: without
    // them a protected host answers the challenge page instead of the image. Sources that declare
    // none keep the direct-URI fast path so ordinary images are still loaded by the renderer.
    const needsContext = !!referer || Object.keys(contextHeaders).length > 0;
    if (!embedded && !forceLocal && !spec.hasOptions && !decodeRule && !needsContext) return spec.url;
    const cacheDir = AppStorage.get<string>('appFilesDir') || '';
    if (!cacheDir) {
      if (spec.decodeAlgorithm || spec.decodeScript) throw new Error('正文图片解密失败：图片缓存目录不可用');
      return spec.url;
    }
    const dir = ReaderImageCache.directory();
    this.ensureDir(dir);
    // data: 地址可能很长，缓存标识里只放它的摘要。
    const urlIdentity = embedded ? `data:${digestHashHex('SHA256', spec.url)}` : spec.url;
    const cacheIdentity = `${source.bookSourceUrl}\n${urlIdentity}\n${decodeRule}` +
      `\n${spec.decodeAlgorithm}\n${spec.decodeKey}\n${spec.decodeIv}\n${spec.decodeIvPrefixBytes || 0}` +
      `\n${JSON.stringify(spec.headers)}`;
    const cacheKey = spec.decodeScript ? digestHashHex('SHA256', JSON.stringify({
      version: 1, identity: cacheIdentity, js: scriptCode, config: scriptConfig, fn: spec.decodeScript,
      params: spec.decodeParams, plain: spec.processPlainImages, index: imageIndex
    })) : digestHashHex('SHA256', cacheIdentity);
    const basePath = `${dir}/${cacheKey}`;
    const existing = this.findExisting(basePath);
    if (existing) {
      if (timing) timing.cacheHit = true;
      ReaderCacheBudget.touchComicFile(existing);
      await ReaderImageCache.registerExisting(existing, source.bookSourceUrl, raw, imageIndex);
      return existing;
    }

    let bytes: Uint8Array;
    if (embedded) {
      bytes = embedded;
    } else {
      const downloadStarted = Date.now();
      const response = await http.executeBinary({
        cookieSource: source.bookSourceUrl,
        cancelCheck: cancelled,
        url: spec.url,
        method: 'GET',
        protectedHeaderNames: Object.keys(spec.headers).filter((name: string): boolean =>
          !/^(?:referer|origin|user-agent|accept|accept-language|authorization|cookie|range)$/i.test(name)),
        headers: this.imageHeaders(spec.headers, contextHeaders, referer),
        connectTimeout: 15000,
        readTimeout: 30000
      }, this.MAX_IMAGE_BYTES);
      if (timing) timing.downloadMs = Date.now() - downloadStarted;
      if (cancelled()) throw new Error(HttpClient.CANCELLED_ERROR);
      if (!response.success || response.data.length === 0) {
        if (spec.decodeAlgorithm || spec.decodeScript) throw new Error(`正文图片下载失败（HTTP ${response.statusCode}）`);
        if (Object.keys(spec.headers).some((name: string): boolean =>
          !/^(?:referer|origin|user-agent|accept|accept-language|authorization|cookie|range)$/i.test(name))) {
          throw new Error(response.error || `正文图片下载失败（HTTP ${response.statusCode}）`);
        }
        console.warn(`[ComicImagePipeline] 图片下载失败 status=${response.statusCode} ` +
          `error=${response.error || ''} url=${spec.url}`);
        return spec.url;
      }
      bytes = response.data;
    }
    if (spec.decodeScript && (spec.processPlainImages || !this.looksLikeImage(bytes))) {
      const scriptStarted = Date.now();
      try {
        bytes = await NativeImageScriptRunner.run(scriptCode, spec.decodeScript, bytes,
          { url: spec.url, index: imageIndex, params: spec.decodeParams }, cancelled);
        if (!this.looksLikeImage(bytes)) throw new Error('脚本返回的字节不是支持的图片格式');
      } catch (e) {
        throw new Error(`content.imageDecode.script (${spec.decodeScript})：${(e as Error).message}`);
      } finally {
        if (timing) timing.scriptMs = Date.now() - scriptStarted;
      }
    }
    const decryptStarted = Date.now();
    if (spec.decodeAlgorithm && !this.looksLikeImage(bytes)) {
      try {
        if (!spec.decodeKey) throw new Error('密钥为空');
        if (spec.decodeIvPrefixBytes === 16) {
          bytes = await SourceImageDecoder.decodeAsync(bytes, {
            algorithm: spec.decodeAlgorithm, key: spec.decodeKey, keyEncoding: 'hex', ivPrefixBytes: 16
          }, this.MAX_IMAGE_BYTES);
        } else {
          bytes = await NativeSourceCrypto.decryptBytesAsync(spec.decodeAlgorithm, bytes, spec.decodeKey, spec.decodeIv);
        }
        if (!this.looksLikeImage(bytes)) throw new Error('解密结果不是支持的图片格式');
      } catch (e) {
        throw new Error(`正文图片解密失败：${(e as Error).message}`);
      }
    }
    if (decodeRule && !this.looksLikeImage(bytes)) {
      const decoded = await this.decodeImage(bytes, decodeRule);
      if (decoded.length > 0) bytes = decoded;
    }
    if (timing) timing.decryptMs = Date.now() - decryptStarted;
    if (!this.looksLikeImage(bytes)) {
      console.warn(`[ComicImagePipeline] 图片响应不是图片（疑似验证页或防盗链拒绝）` +
        `bytes=${bytes.length} url=${embedded ? 'data:' : spec.url}`);
      return spec.url;
    }
    if (cancelled()) throw new Error(HttpClient.CANCELLED_ERROR);
    const path = `${basePath}${this.imageExtension(bytes, spec.url)}`;
    await ReaderImageCache.commit(path, bytes, source.bookSourceUrl, raw, imageIndex);
    ReaderCacheBudget.noteComicWrite(path);
    return path;

  }

  private static async decodeImage(input: Uint8Array, rule: string): Promise<Uint8Array> {
    if (!/createSymmetricCrypto\s*\(/.test(rule || '')) return new Uint8Array();
    const algorithm = this.readCryptoAlgorithm(rule);
    if (!/^aes\/cbc\/pkcs(?:5|7)padding$/i.test(algorithm)) return new Uint8Array();
    const key = this.readCryptoKey(rule);
    const keyBytes = new util.TextEncoder().encodeInto(key);
    if (![16, 24, 32].includes(keyBytes.length)) return new Uint8Array();
    const bits = keyBytes.length * 8;
    const generator = cryptoFramework.createSymKeyGenerator(`AES${bits}`);
    const symKey = await generator.convertKey({ data: keyBytes });
    try {
      const cipher = cryptoFramework.createCipher(`AES${bits}|CBC|PKCS7`);
      const iv = this.readCryptoIv(rule, key);
      const ivBytes = new util.TextEncoder().encodeInto(iv);
      if (ivBytes.length !== 16) return new Uint8Array();
      const params: cryptoFramework.IvParamsSpec = {
        algName: 'IvParamsSpec',
        iv: { data: ivBytes }
      };
      await cipher.init(cryptoFramework.CryptoMode.DECRYPT_MODE, symKey, params);
      const output = await cipher.doFinal({ data: input });
      return output && output.data ? output.data : new Uint8Array();
    } catch (e) {
      console.warn('[ComicImagePipeline] imageDecode failed:', e);
      return new Uint8Array();
    } finally {
      symKey.clearMem();
      keyBytes.fill(0);
    }
  }

  private static readCryptoAlgorithm(rule: string): string {
    const match = (rule || '').match(/createSymmetricCrypto\s*\(\s*(['"])(.*?)\1/i);
    return match ? match[2].trim() : '';
  }

  private static readCryptoKey(rule: string): string {
    const fallback = (rule || '').match(/cache\.get\(\s*(['"])[^'"]+\1\s*\)\s*\|\|\s*(['"])(.*?)\2/);
    if (fallback && fallback[3]) return fallback[3];
    const direct = (rule || '').match(/(?:var|let|const)?\s*key\s*=\s*(['"])(.*?)\1/);
    if (direct && direct[2]) return direct[2];
    const call = (rule || '').match(/createSymmetricCrypto\s*\(\s*(['"])[^'"]+\1\s*,\s*(['"])(.*?)\2/);
    return call && call[3] ? call[3] : '';
  }

  private static readCryptoIv(rule: string, fallback: string): string {
    const call = (rule || '').match(
      /createSymmetricCrypto\s*\(\s*(['"])[^'"]+\1\s*,\s*[^,]+,\s*(['"])(.*?)\2/);
    return call && call[3] ? call[3] : fallback;
  }

  /** data:image/...;base64, 地址解出的字节；不是这种地址时返回 null，数据损坏或过大时抛出原因。 */
  private static dataImageBytes(url: string): Uint8Array | null {
    const header = /^data:image\/[\w.+-]+(?:;[\w-]+=[^;,]*)*;base64,/i.exec(url || '');
    if (!header) return null;
    let payload = url.substring(header[0].length).replace(/\s+/g, '');
    if (payload.includes('%')) {
      try {
        payload = decodeURIComponent(payload);
      } catch (_) {
      }
    }
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    if (!payload) throw new Error('内嵌图片没有数据');
    if (payload.length > Math.ceil(this.MAX_IMAGE_BYTES / 3) * 4 + 4) throw new Error('内嵌图片数据超过 20 MiB');
    let bytes: Uint8Array;
    try {
      bytes = new util.Base64Helper().decodeSync(payload);
    } catch (_) {
      throw new Error('内嵌图片的 Base64 数据无效');
    }
    if (!bytes || bytes.length === 0) throw new Error('内嵌图片的 Base64 数据无效');
    return bytes;
  }

  private static findOptionIndex(value: string): number {
    for (let index = value.length - 1; index >= 0; index--) {
      if (value.charAt(index) !== ',') continue;
      const tail = value.substring(index + 1).trim();
      if (tail.startsWith('{') && tail.endsWith('}')) return index;
    }
    return -1;
  }

  private static allowedHeader(name: string): boolean {
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name || '') &&
      !/^(?:host|connection|content-length|transfer-encoding|keep-alive|upgrade|te|trailer|proxy-.*|sec-.*|__proto__|constructor|prototype)$/i.test(name);
  }

  private static looksLikeImage(bytes: Uint8Array): boolean {
    return SourceImageDecoder.isImage(bytes);
  }

  private static imageExtension(bytes: Uint8Array, url: string): string {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return '.gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return '.bmp';
    const ascii = String.fromCharCode(...Array.from(bytes.subarray(0, 16)));
    if (ascii.startsWith('RIFF')) return '.webp';
    if (ascii.substring(4, 12).includes('ftypavi')) return '.avif';
    if (/^ftyp(?:heic|heix|mif1|msf1)$/.test(ascii.substring(4, 12))) return '.heic';
    const match = (url || '').match(/\.(jpe?g|png|gif|webp|bmp|avif)(?:[?#]|$)/i);
    return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
  }

  private static findExisting(basePath: string): string {
    for (const ext of ['.jpg', '.png', '.gif', '.webp', '.bmp', '.avif', '.heic']) {
      const path = `${basePath}${ext}`;
      try {
        if (ReaderImageCache.exists(path)) return path;
      } catch (_) {
      }
    }
    return '';
  }

  private static ensureDir(path: string): void {
    try {
      fs.mkdirSync(path, true);
    } catch (_) {
    }
  }

  private static hashText(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  private static decodeEntities(value: string): string {
    return (value || '').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&')
      .replace(/&#39;/g, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  }
}
