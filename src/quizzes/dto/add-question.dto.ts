import { CreateQuestionInput } from './create-quiz.dto';

// A question added to an existing quiz has the same shape as one supplied at
// quiz-creation time.
export class AddQuestionDto extends CreateQuestionInput {}
