import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

// The COMPLETE ordered id list, not a pair of indices. The service asserts the
// set matches the quiz's questions exactly, which makes a partial reorder
// impossible and keeps the write to one query.
export class ReorderQuestionsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  questionIds: string[];
}
