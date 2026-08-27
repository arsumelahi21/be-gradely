import Papa from 'papaparse';
import { QuestionType } from '../common/types/quiz.type';
import { CreateQuestionInput } from './dto/create-quiz.dto';

/**
 * CSV → questions. PURE: no Prisma, no I/O, no clock — so it unit-tests
 * directly, the same reason `fees/fee-calculator.ts` is a separate module.
 *
 * Parsing is delegated to papaparse rather than `split(',')` because question
 * text routinely contains commas and quotes, which is exactly where a
 * hand-rolled splitter produces silently-wrong columns.
 */

/** Hard cap so one upload cannot write thousands of rows in a transaction. */
export const MAX_IMPORT_QUESTIONS = 200;

/** Option columns, in order. The letter IS the option id. */
export const OPTION_COLUMNS = [
  'option_a',
  'option_b',
  'option_c',
  'option_d',
  'option_e',
  'option_f',
] as const;

export const TEMPLATE_HEADERS = [
  'type',
  'text',
  ...OPTION_COLUMNS,
  'correct',
  'points',
] as const;

export interface ImportRowError {
  /** 1-based row number as the teacher sees it in a spreadsheet (header = 1). */
  row: number;
  column?: string;
  message: string;
}

export interface ParseQuizCsvResult {
  questions: CreateQuestionInput[];
  errors: ImportRowError[];
}

/** The downloadable starter file. Kept beside the parser so the two agree. */
export function buildImportTemplateCsv(): string {
  const rows = [
    TEMPLATE_HEADERS.join(','),
    // Deliberately includes a comma inside quoted text — proves to whoever
    // edits this template that quoting works.
    'MULTIPLE_CHOICE,"What is 2 + 2, roughly?",3,4,5,6,,,b,2',
    'TRUE_FALSE,The sky is blue.,,,,,,,true,1',
  ];
  return rows.join('\r\n') + '\r\n';
}

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, '_');
}

function parseBooleanish(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (['true', 't', 'yes', 'y', '1'].includes(v)) return true;
  if (['false', 'f', 'no', 'n', '0'].includes(v)) return false;
  return null;
}

function parseTypeCell(raw: string): QuestionType | null {
  const v = raw
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (v === 'MULTIPLE_CHOICE' || v === 'MCQ') {
    return QuestionType.MULTIPLE_CHOICE;
  }
  if (v === 'TRUE_FALSE' || v === 'TF') return QuestionType.TRUE_FALSE;
  return null;
}

export function parseQuizCsv(csv: string): ParseQuizCsvResult {
  const errors: ImportRowError[] = [];
  const questions: CreateQuestionInput[] = [];

  const parsed = Papa.parse<Record<string, string>>(csv.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: normaliseHeader,
  });

  const headers = (parsed.meta.fields ?? []).map(normaliseHeader);
  for (const required of ['type', 'text', 'correct']) {
    if (!headers.includes(required)) {
      errors.push({
        row: 1,
        column: required,
        message: `Missing required column "${required}"`,
      });
    }
  }
  if (errors.length > 0) return { questions, errors };

  const rows = parsed.data;
  if (rows.length === 0) {
    return {
      questions,
      errors: [{ row: 1, message: 'The file has no question rows' }],
    };
  }
  if (rows.length > MAX_IMPORT_QUESTIONS) {
    return {
      questions,
      errors: [
        {
          row: 1,
          message: `A quiz can have at most ${MAX_IMPORT_QUESTIONS} questions; this file has ${rows.length}`,
        },
      ],
    };
  }

  rows.forEach((raw, i) => {
    // +2: one for the header line, one to make it 1-based.
    const row = i + 2;
    const cell = (name: string) => (raw[name] ?? '').trim();

    const type = parseTypeCell(cell('type'));
    if (!type) {
      errors.push({
        row,
        column: 'type',
        message: `type must be MULTIPLE_CHOICE or TRUE_FALSE (got "${cell('type')}")`,
      });
      return;
    }

    const text = cell('text');
    if (!text) {
      errors.push({ row, column: 'text', message: 'text is required' });
      return;
    }

    const pointsRaw = cell('points');
    let points = 1;
    if (pointsRaw) {
      const n = Number(pointsRaw);
      if (!Number.isInteger(n) || n < 0) {
        errors.push({
          row,
          column: 'points',
          message: `points must be a whole number of 0 or more (got "${pointsRaw}")`,
        });
        return;
      }
      points = n;
    }

    const correct = cell('correct');
    if (!correct) {
      errors.push({ row, column: 'correct', message: 'correct is required' });
      return;
    }

    if (type === QuestionType.TRUE_FALSE) {
      const bool = parseBooleanish(correct);
      if (bool === null) {
        errors.push({
          row,
          column: 'correct',
          message: `correct must be true or false for a TRUE_FALSE question (got "${correct}")`,
        });
        return;
      }
      questions.push({
        type,
        text,
        correctAnswer: bool,
        points,
      } as CreateQuestionInput);
      return;
    }

    // MULTIPLE_CHOICE: the column letter is the option id.
    const options = OPTION_COLUMNS.map((col) => ({
      id: col.replace('option_', ''),
      text: cell(col),
    })).filter((o) => o.text.length > 0);

    if (options.length < 2) {
      errors.push({
        row,
        column: 'option_a',
        message: `a multiple-choice question needs at least 2 non-empty options (got ${options.length})`,
      });
      return;
    }

    const answerId = correct.toLowerCase();
    if (!options.some((o) => o.id === answerId)) {
      errors.push({
        row,
        column: 'correct',
        message: `correct must name a filled option column (${options
          .map((o) => o.id)
          .join(', ')}) — got "${correct}"`,
      });
      return;
    }

    questions.push({
      type,
      text,
      options,
      correctAnswer: answerId,
      points,
    } as CreateQuestionInput);
  });

  return { questions, errors };
}
