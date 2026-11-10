import fs from '@ohos.file.fs';
import { CloudFileItem } from './CloudFileModels';
import { ReaderFontHelper, ReaderFontItem } from '../utils/ReaderFontHelper';
import { ReaderSettingsStore } from '../utils/ReaderSettingsStore';

class CloudFontData {
  fonts: ReaderFontItem[] = [];
}

export class CloudFontImport {
  static localPath(filesDir: string, file: CloudFileItem): string {
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    if (file.kind !== 'FONT' || !['ttf', 'otf', 'ttc'].includes(extension) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(file.id)) return '';
    return `${filesDir}/reader_fonts/cloud_${file.id}.${extension}`;
  }

  static uploadName(sourceName: string, filePath: string): string {
    const name = ReaderFontHelper.resolveDisplayName(sourceName, filePath);
    const extension = filePath.split('.').pop()?.toLowerCase() || 'ttf';
    return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
  }

  // Also repairs fonts downloaded by older builds without downloading their bytes again.
  static async saveNames(context: Context, filesDir: string, files: CloudFileItem[]): Promise<void> {
    const imported = files.filter((file: CloudFileItem) => {
      const path = CloudFontImport.localPath(filesDir, file);
      return path.length > 0 && fs.accessSync(path);
    });
    if (!imported.length) return;
    const raw = AppStorage.get<string>('readerCustomFontsRaw') || '';
    const data = new CloudFontData();
    if (raw) {
      const parsed = JSON.parse(raw) as CloudFontData | ReaderFontItem[];
      data.fonts = Array.isArray(parsed) ? parsed as ReaderFontItem[] : (parsed as CloudFontData).fonts;
      // Never replace an unreadable existing library with an empty one.
      if (!Array.isArray(data.fonts)) throw new Error('本机字体记录无法读取');
    }
    const selectedPath = AppStorage.get<string>('readerFontFilePath') || '';
    const previousName = AppStorage.get<string>('readerFontSourceName') || '系统默认';
    let selectedName = previousName;
    let changed = false;
    for (const file of imported) {
      const path = CloudFontImport.localPath(filesDir, file);
      const name = ReaderFontHelper.resolveDisplayName(file.name, path);
      const existing = data.fonts.find((font: ReaderFontItem) => font.filePath === path);
      if (existing) {
        if (existing.sourceName !== name) { existing.sourceName = name; changed = true; }
      } else {
        const font = new ReaderFontItem();
        font.familyName = ReaderFontHelper.stableFontFamily(path);
        font.filePath = path;
        font.sourceName = name;
        data.fonts.push(font);
        changed = true;
      }
      if (selectedPath === path) selectedName = name;
    }
    if (!changed && selectedName === previousName) return;
    const nextRaw = JSON.stringify(data);
    await ReaderSettingsStore.saveFontSettings(context,
      AppStorage.get<string>('readerFontFamily') || '', selectedPath, selectedName,
      AppStorage.get<string>('readerFontMode') || ReaderSettingsStore.FONT_MODE_DEVICE,
      AppStorage.get<string>('readerSystemFontFamily') || '', nextRaw);
    AppStorage.setOrCreate('readerCustomFontsRaw', nextRaw);
    AppStorage.setOrCreate('readerFontSourceName', selectedName);
  }
}
