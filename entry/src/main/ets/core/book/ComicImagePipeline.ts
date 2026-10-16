import fs from '@ohos.file.fs';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BookSource } from '../../model/data/Book';
import { HttpClient } from '../http/HttpClient';

export class ComicImageSpec {
  url: string = '';
  headers: Record<string, string> = {};
  hasOptions: boolean = false;
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
      const headerObject = options['headers'];
      if (headerObject && typeof headerObject === 'object' && !Array.isArray(headerObject)) {
        const record = headerObject as Record<string, Object>;
        for (const key in record) {
          const headerValue = String(record[key] || '').trim();
          if (this.allowedHeader(key) && headerValue) spec.headers[key] = headerValue;
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

  static async materialize(http: HttpClient, source: BookSource, raw: string,
    context: ComicImageRequestContext | null = null): Promise<string> {
    return await this.materializeRequest(http, source.bookSourceUrl || '', raw, context,
      source.contentRule?.imageDecode || '');
  }

  /**
   * Downloads one image address with an explicit request context. Covers use the same channel and
   * the same on-disk cache as chapter artwork; `cacheKey` is the source URL the address was found
   * on, so one address cached for a source is reused by every later render of that source.
   */
  static async materializeRequest(http: HttpClient, cacheKey: string, raw: string,
    context: ComicImageRequestContext | null = null, decodeRule: string = ''): Promise<string> {
    const spec = this.parse(raw);
    if (!/^https?:\/\//i.test(spec.url)) return spec.url || raw;
    const contextHeaders: Record<string, string> = context ? context.headers : {};
    const referer = context ? String(context.referer || '').trim() : '';
    // Sources that declare their own browser headers need the same headers for artwork: without
    // them a protected host answers the challenge page instead of the image. Sources that declare
    // none keep the direct-URI fast path so ordinary images are still loaded by the renderer.
    const needsContext = !!referer || Object.keys(contextHeaders).length > 0;
    if (!spec.hasOptions && !decodeRule && !needsContext) return spec.url;
    const cacheDir = AppStorage.get<string>('appCacheDir') || '';
    if (!cacheDir) return spec.url;
    const dir = `${cacheDir}/comic_images`;
    this.ensureDir(dir);
    const basePath = `${dir}/${this.hashText(`${cacheKey}\n${spec.url}\n${decodeRule}`)}`;
    const existing = this.findExisting(basePath);
    if (existing) return existing;

    const headers: Record<string, string> = {
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
    };
    for (const key of Object.keys(contextHeaders)) {
      // The jar owns cookies; a source-level Cookie must never be replayed to an image host.
      if (/^cookie$/i.test(key) || !this.allowedHeader(key)) continue;
      headers[key] = contextHeaders[key];
    }
    if (referer) headers['Referer'] = referer;
    for (const key of Object.keys(spec.headers)) headers[key] = spec.headers[key];

    const response = await http.executeBinary({
      url: spec.url,
      method: 'GET',
      headers: headers,
      connectTimeout: 15000,
      readTimeout: 30000
    }, this.MAX_IMAGE_BYTES);
    if (!response.success || response.data.length === 0) {
      console.warn(`[ComicImagePipeline] 图片下载失败 status=${response.statusCode} ` +
        `error=${response.error || ''} url=${spec.url}`);
      return spec.url;
    }

    let bytes = response.data;
    if (decodeRule && !this.looksLikeImage(bytes)) {
      const decoded = await this.decodeImage(bytes, decodeRule);
      if (decoded.length > 0) bytes = decoded;
    }
    if (!this.looksLikeImage(bytes)) {
      console.warn(`[ComicImagePipeline] 图片响应不是图片（疑似验证页或防盗链拒绝）` +
        `status=${response.statusCode} bytes=${bytes.length} url=${spec.url}`);
      return spec.url;
    }
    const path = `${basePath}${this.imageExtension(bytes, spec.url)}`;
    const file = fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.WRITE_ONLY | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, bytes.buffer);
    } finally {
      fs.closeSync(file);
    }
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

  private static findOptionIndex(value: string): number {
    for (let index = value.length - 1; index >= 0; index--) {
      if (value.charAt(index) !== ',') continue;
      const tail = value.substring(index + 1).trim();
      if (tail.startsWith('{') && tail.endsWith('}')) return index;
    }
    return -1;
  }

  private static allowedHeader(name: string): boolean {
    return /^(?:referer|origin|user-agent|accept|accept-language|authorization|cookie|range)$/i.test(name || '');
  }

  private static looksLikeImage(bytes: Uint8Array): boolean {
    if (bytes.length < 12) return false;
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return true;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return true;
    const ascii = String.fromCharCode(...Array.from(bytes.subarray(0, 16)));
    return ascii.startsWith('RIFF') && ascii.substring(8, 12) === 'WEBP' ||
      ascii.substring(4, 12).includes('ftypavif') || ascii.substring(4, 12).includes('ftypavis');
  }

  private static imageExtension(bytes: Uint8Array, url: string): string {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return '.gif';
    if (bytes[0] === 0x42 && bytes[1] === 0x4D) return '.bmp';
    const ascii = String.fromCharCode(...Array.from(bytes.subarray(0, 16)));
    if (ascii.startsWith('RIFF')) return '.webp';
    if (ascii.substring(4, 12).includes('ftypavi')) return '.avif';
    const match = (url || '').match(/\.(jpe?g|png|gif|webp|bmp|avif)(?:[?#]|$)/i);
    return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
  }

  private static findExisting(basePath: string): string {
    for (const ext of ['.jpg', '.png', '.gif', '.webp', '.bmp', '.avif']) {
      const path = `${basePath}${ext}`;
      try {
        if (fs.accessSync(path)) return path;
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
