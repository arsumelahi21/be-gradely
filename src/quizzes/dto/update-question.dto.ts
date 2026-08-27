import { PartialType } from '@nestjs/swagger';
import { CreateQuestionInput } from './create-quiz.dto';

// Every field optional — a patch may change only `text`, or only `points`.
// `correctAnswer` therefore loses its `@IsDefined()`, so the service validates
// the MERGED question (existing row + patch), not the patch alone: changing an
// MCQ's correctAnswer has to be checked against the options already stored.
export class UpdateQuestionDto extends PartialType(CreateQuestionInput) {}
