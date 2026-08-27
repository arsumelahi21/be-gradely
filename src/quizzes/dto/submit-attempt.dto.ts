import { IsObject } from 'class-validator';

export class SubmitAttemptDto {
  // Map of questionId -> answer (option id for MCQ, boolean for TRUE_FALSE).
  // Values are validated per-question against the quiz in the service.
  @IsObject()
  answers: Record<string, string | boolean>;
}
