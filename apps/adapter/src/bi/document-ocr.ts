import type { Runtime } from '../../../launcher/src/runtime.ts';
import { windowsOcr } from './windows-ocr.ts';
import type { OcrLanguage } from './windows-ocr.ts';
import type { OcrLine } from './windows-ocr.ts';

export type OcrOptions = { language: OcrLanguage; mode: 'auto' | 'local' | 'model' };
export const defaultOcr: OcrOptions = { language: 'auto', mode: 'auto' };
export const documentFileLimit = 10 * 1024 * 1024;
export const ocrFrameLimit = Math.ceil(documentFileLimit / 3) * 4 + 256;

export function parseOcr(value: unknown): OcrOptions | undefined {
  if (!value || typeof value !== 'object') return;
  const { language, mode } = value as Partial<OcrOptions>;
  if ((language === 'auto' || language === 'en-US' || language === 'zh-Hant-TW') &&
      (mode === 'auto' || mode === 'local' || mode === 'model')) return { language, mode };
}

export type OcrProvenance = { provenance: 'OCR'; engine: string };
const mark = (engine: string): OcrProvenance => ({ provenance: 'OCR', engine });

export function ocrLocator(locator: string, ocr?: OcrProvenance) {
  return ocr ? `${locator} [OCR: ${ocr.engine}]` : locator;
}

type Vision = NonNullable<Runtime['knowledge']>['ocrVision'];
type OcrPage = { status: 'local' | 'model' | 'failed'; warning?: string; ocr?: OcrProvenance;
  text?: string; lines?: OcrLine[]; width?: number; height?: number };
export type DocumentOcr = (input: Record<string, unknown>, signal: AbortSignal) => Promise<OcrPage>;

export function documentOcr(options: OcrOptions, vision: Vision, preferred?: string): DocumentOcr {
  const alias = options.mode === 'local' ? undefined : vision.select(preferred);
  let lastPage = 0;
  let requests = 0;
  let visionBlocked: 'vision-unsupported' | 'vision-unavailable' | undefined;
  return async ({ page, mime, base64 }, signal) => {
    if (typeof page !== 'number' || !Number.isInteger(page) || page <= lastPage || page > 120 ||
        (mime !== 'image/png' && mime !== 'image/jpeg') || typeof base64 !== 'string' ||
        base64.length > ocrFrameLimit - 256) throw new Error('Invalid OCR input');
    const image = Buffer.from(base64, 'base64');
    const png = image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const jpeg = image.subarray(0, 3).toString('hex') === 'ffd8ff';
    if (image.length > documentFileLimit || !(mime === 'image/png' ? png : jpeg)) throw new Error('Invalid OCR image');
    lastPage = page;

    const local = await windowsOcr(image, options.language, signal);
    const localPage: OcrPage = local.text && /[\p{L}\p{N}]/u.test(local.text)
      ? { text: local.text, lines: local.lines, width: local.width, height: local.height, status: 'local',
        ocr: mark(`Windows.Media.Ocr (${local.language})`) }
      : { status: 'failed' };
    const localWarning = local.warning ?? (local.sufficient ? undefined : 'local-low-text');
    if (options.mode === 'local' || (options.mode === 'auto' && local.sufficient)) return { ...localPage, warning: localWarning };
    if (!alias) return { ...localPage, warning: 'vision-no-model' };
    if (visionBlocked) return { ...localPage, warning: visionBlocked };
    if (requests >= 8) return { ...localPage, warning: 'vision-budget' };
    requests++;
    const model = await vision.recognize(alias, image, mime, options.language, signal);
    if ('text' in model && model.text) return { status: 'model', text: model.text, ocr: mark(alias) };
    if (model.warning === 'vision-unsupported' || model.warning === 'vision-unavailable') visionBlocked = model.warning;
    return { ...localPage, warning: model.warning };
  };
}
