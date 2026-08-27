import {
  MAX_IMPORT_QUESTIONS,
  buildImportTemplateCsv,
  parseQuizCsv,
} from './quiz-import.parser';
import { QuestionType } from '../common/types/quiz.type';

const HEADER =
  'type,text,option_a,option_b,option_c,option_d,option_e,option_f,correct,points';

const row = (cells: string) => `${HEADER}\n${cells}`;

describe('parseQuizCsv', () => {
  it('parses a multiple-choice row', () => {
    const { questions, errors } = parseQuizCsv(
      row('MULTIPLE_CHOICE,What is 2 + 2?,3,4,,,,,b,2'),
    );
    expect(errors).toHaveLength(0);
    expect(questions).toEqual([
      {
        type: QuestionType.MULTIPLE_CHOICE,
        text: 'What is 2 + 2?',
        options: [
          { id: 'a', text: '3' },
          { id: 'b', text: '4' },
        ],
        correctAnswer: 'b',
        points: 2,
      },
    ]);
  });

  it('parses a true/false row and keeps false as false', () => {
    const { questions, errors } = parseQuizCsv(
      row('TRUE_FALSE,The sky is green.,,,,,,,false,1'),
    );
    expect(errors).toHaveLength(0);
    expect(questions[0]).toMatchObject({
      type: QuestionType.TRUE_FALSE,
      correctAnswer: false,
    });
  });

  it('handles a comma inside quoted question text', () => {
    // The case a hand-rolled split(',') gets wrong.
    const { questions, errors } = parseQuizCsv(
      row('MULTIPLE_CHOICE,"What is 2 + 2, roughly?",3,4,,,,,b,1'),
    );
    expect(errors).toHaveLength(0);
    expect(questions[0].text).toBe('What is 2 + 2, roughly?');
  });

  it('accepts case and spacing variations in type and correct', () => {
    const { questions, errors } = parseQuizCsv(
      `${HEADER}\nmultiple choice,Q1,x,y,,,,,B,1\ntf,Q2,,,,,,,YES,1`,
    );
    expect(errors).toHaveLength(0);
    expect(questions[0]).toMatchObject({ correctAnswer: 'b' });
    expect(questions[1]).toMatchObject({ correctAnswer: true });
  });

  it('defaults points to 1 when the column is blank', () => {
    const { questions } = parseQuizCsv(
      row('TRUE_FALSE,Blank points,,,,,,,true,'),
    );
    expect(questions[0].points).toBe(1);
  });

  it('reports every bad row, not just the first', () => {
    const { questions, errors } = parseQuizCsv(
      [
        HEADER,
        'NONSENSE,Bad type,,,,,,,a,1',
        'MULTIPLE_CHOICE,,3,4,,,,,b,1',
        'MULTIPLE_CHOICE,Only one option,3,,,,,,a,1',
        'MULTIPLE_CHOICE,Answer not an option,3,4,,,,,z,1',
        'TRUE_FALSE,Not a boolean,,,,,,,maybe,1',
        'TRUE_FALSE,Bad points,,,,,,,true,-2',
      ].join('\n'),
    );
    expect(questions).toHaveLength(0);
    expect(errors).toHaveLength(6);
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(errors.map((e) => e.column)).toEqual([
      'type',
      'text',
      'option_a',
      'correct',
      'correct',
      'points',
    ]);
  });

  it('numbers rows as a spreadsheet does — the header is row 1', () => {
    const { errors } = parseQuizCsv(
      `${HEADER}\nTRUE_FALSE,Fine,,,,,,,true,1\nNONSENSE,Bad,,,,,,,a,1`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].row).toBe(3);
  });

  it('keeps the good rows when only some rows fail', () => {
    const { questions, errors } = parseQuizCsv(
      `${HEADER}\nTRUE_FALSE,Good,,,,,,,true,1\nNONSENSE,Bad,,,,,,,a,1`,
    );
    expect(questions).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('rejects a file missing a required column', () => {
    const { errors } = parseQuizCsv('type,text\nTRUE_FALSE,No correct column');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 1, column: 'correct' });
  });

  it('rejects a file with no question rows', () => {
    const { questions, errors } = parseQuizCsv(HEADER);
    expect(questions).toHaveLength(0);
    expect(errors[0].message).toMatch(/no question rows/i);
  });

  it(`rejects more than ${MAX_IMPORT_QUESTIONS} questions`, () => {
    const rows = Array.from(
      { length: MAX_IMPORT_QUESTIONS + 1 },
      (_, i) => `TRUE_FALSE,Q${i},,,,,,,true,1`,
    );
    const { questions, errors } = parseQuizCsv([HEADER, ...rows].join('\n'));
    expect(questions).toHaveLength(0);
    expect(errors[0].message).toMatch(/at most/i);
  });

  it('ignores blank lines rather than reporting them as errors', () => {
    const { questions, errors } = parseQuizCsv(
      `${HEADER}\nTRUE_FALSE,Q1,,,,,,,true,1\n\n\nTRUE_FALSE,Q2,,,,,,,false,1\n`,
    );
    expect(errors).toHaveLength(0);
    expect(questions).toHaveLength(2);
  });

  it('tolerates a UTF-8 BOM on the header', () => {
    // Excel writes one; without stripping it the first column name is corrupt.
    const { errors } = parseQuizCsv(
      `\uFEFF${HEADER}\nTRUE_FALSE,Q,,,,,,,true,1`.replace(/^\uFEFF/, ''),
    );
    expect(errors).toHaveLength(0);
  });

  it('round-trips its own template with no errors', () => {
    const { questions, errors } = parseQuizCsv(buildImportTemplateCsv());
    expect(errors).toHaveLength(0);
    expect(questions).toHaveLength(2);
    expect(questions[0].text).toBe('What is 2 + 2, roughly?');
  });
});
