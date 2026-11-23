import { parseAsk } from '../../../../packages/knowledge/src/ask.ts';
import { string } from '../../../../packages/knowledge/src/snapshot.ts';
import { defaultOcr, parseOcr, type OcrOptions } from './document-ocr.ts';

export type Question = { question: string; expect: string | null };
export type PipelineSettings = {
  convert: { reader: 'auto' | 'text' | 'html' | 'pdf' | 'image'; ocr: OcrOptions };
  ingest: { method: 'model' | 'rules'; model: string; labels: Record<string, string>;
    duplicates: 'hold' | 'update'; minEvidence: number };
  testing: { name: string; model: string; questions: Question[]; threshold: number; evidenceChecks: boolean };
};
export type PipelineMode = 'automatic' | 'step';
export const defaults: PipelineSettings = {
  convert: { reader: 'auto', ocr: defaultOcr },
  ingest: { method: 'model', model: '', labels: {}, duplicates: 'hold', minEvidence: 1 },
  testing: { name: 'Default', model: '', questions: [], threshold: 100, evidenceChecks: true },
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid BI stage settings');
  return value as Record<string, unknown>;
}

function oneOf<const T extends string>(value: unknown, options: readonly T[]): T {
  const match = options.find(option => option === value);
  if (match === undefined) throw new Error('Invalid BI option');
  return match;
}

function integer(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid BI threshold');
  return value;
}

function bool(value: unknown) {
  if (typeof value !== 'boolean') throw new Error('Invalid BI option');
  return value;
}

export function stageSettings(stage: unknown, value: unknown, fields: string[], aliases: readonly string[]): Partial<PipelineSettings> {
  const input = record(value);
  const model = () => oneOf(input.model, ['', ...aliases]);
  switch (stage) {
    case 'convert': {
      const ocr = input.ocr === undefined ? defaultOcr : parseOcr(input.ocr);
      if (!ocr) throw new Error('Invalid BI OCR settings');
      return { convert: { reader: oneOf(input.reader, ['auto', 'text', 'html', 'pdf', 'image']), ocr } };
    }
    case 'ingest': {
      const labels = Object.entries(record(input.labels));
      if (labels.some(([field]) => field !== 'name' && !fields.includes(field))) {
        throw new Error('Field rules must match the selected schema');
      }
      return { ingest: { method: oneOf(input.method, ['model', 'rules']), model: model(),
        labels: Object.fromEntries(labels.map(([field, label]) => [field, string(label, 'label', 100).trim()])),
        duplicates: oneOf(input.duplicates, ['hold', 'update']), minEvidence: integer(input.minEvidence, 1, fields.length) } };
    }
    case 'testing': {
      if (!Array.isArray(input.questions) || input.questions.length > 24) throw new Error('Expected up to 24 benchmark questions');
      const questions = input.questions.map(value => {
        const row = record(value);
        const query = parseAsk({ vault: 'benchmark', question: row.question });
        if (!query) throw new Error('Invalid benchmark question');
        return { question: query.question, expect: row.expect === null ? null : string(row.expect, 'expected answer', 300).trim() };
      });
      return { testing: { name: string(input.name, 'question set', 80).trim(), model: model(), questions,
        threshold: integer(input.threshold, 1, 100), evidenceChecks: bool(input.evidenceChecks) } };
    }
    default: throw new Error('Unknown BI stage');
  }
}
