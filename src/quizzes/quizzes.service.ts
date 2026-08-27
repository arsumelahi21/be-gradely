import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';
import {
  NOTIFICATION_CREATE,
  NotificationCreateEvent,
} from '../common/events/notification.events';
import {
  parentUserIds,
  sectionStudentIds,
  studentUserIds,
} from '../common/notifications/recipients';
import { QuestionType, QuizAttemptStatus } from '../common/types/quiz.type';
import { CreateQuizDto, CreateQuestionInput } from './dto/create-quiz.dto';
import { AddQuestionDto } from './dto/add-question.dto';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { FindQuizzesQueryDto } from './dto/find-quizzes-query.dto';
import { UpdateQuizDto } from './dto/update-quiz.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { ReorderQuestionsDto } from './dto/reorder-questions.dto';
import { ImportQuizDto } from './dto/import-quiz.dto';
import { buildImportTemplateCsv, parseQuizCsv } from './quiz-import.parser';

/**
 * Browsers and Excel disagree about a .csv's MIME type — Windows commonly
 * reports `application/vnd.ms-excel` for one. The allow-list is deliberately
 * narrow but covers what real uploads actually send.
 */
const IMPORT_MIME_TYPES = new Set([
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);
const MAX_IMPORT_BYTES = 1024 * 1024; // 1 MB

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class QuizzesService extends BaseSchoolScopedService {
  constructor(
    prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super(prisma);
  }

  // ---- helpers -----------------------------------------------------------

  private async teacherProfileIdFor(actor: Actor): Promise<string | null> {
    if (!actor.userId) return null;
    const tp = await this.prisma.teacherProfile.findUnique({
      where: { userId: actor.userId },
      select: { id: true },
    });
    return tp?.id ?? null;
  }

  private async studentProfileFor(actor: Actor) {
    if (!actor.userId) return null;
    return this.prisma.studentProfile.findUnique({
      where: { userId: actor.userId },
      select: { id: true, schoolId: true, userId: true },
    });
  }

  /** Teacher may write quizzes only for a section they teach; admins within scope. */
  private async assertSectionWriteAccess(
    actor: Actor,
    section: { id: string; schoolId: string },
  ) {
    this.enforceScope(actor, section.schoolId);
    if (actor.role === Role.TEACHER) {
      const myTeacherId = await this.teacherProfileIdFor(actor);
      if (!myTeacherId)
        throw new ForbiddenException('Teacher profile not found');
      const teaches = await this.prisma.sectionSubject.findFirst({
        where: { sectionId: section.id, teacherId: myTeacherId },
        select: { id: true },
      });
      if (!teaches) {
        throw new ForbiddenException('You do not teach this section');
      }
    }
  }

  private validateQuestionShape(q: CreateQuestionInput) {
    if (q.type === QuestionType.MULTIPLE_CHOICE) {
      if (!q.options || q.options.length < 2) {
        throw new BadRequestException(
          'Multiple-choice questions need at least 2 options',
        );
      }
      const ids = new Set(q.options.map((o) => o.id));
      if (ids.size !== q.options.length) {
        throw new BadRequestException('Option ids must be unique');
      }
      if (typeof q.correctAnswer !== 'string' || !ids.has(q.correctAnswer)) {
        throw new BadRequestException(
          'correctAnswer must be one of the option ids',
        );
      }
    } else if (q.type === QuestionType.TRUE_FALSE) {
      if (typeof q.correctAnswer !== 'boolean') {
        throw new BadRequestException(
          'correctAnswer must be a boolean for true/false questions',
        );
      }
    }
  }

  /** Strip correctAnswer from questions before returning to a student. */
  private sanitizeQuestions(questions: any[]) {
    return questions.map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      options: q.options ?? null,
      points: q.points,
      order: q.order,
    }));
  }

  private isCorrect(q: any, answer: unknown): boolean {
    if (answer === undefined || answer === null) return false;
    if (q.type === QuestionType.TRUE_FALSE) {
      return Boolean(q.correctAnswer) === Boolean(answer);
    }
    return String(q.correctAnswer) === String(answer as string | number);
  }

  private scoreAttempt(
    questions: any[],
    answers: Record<string, unknown>,
  ): { score: number; maxScore: number } {
    let score = 0;
    let maxScore = 0;
    for (const q of questions) {
      maxScore += q.points;
      if (this.isCorrect(q, answers?.[q.id])) score += q.points;
    }
    return { score, maxScore };
  }

  // ---- teacher / admin ---------------------------------------------------

  async createQuiz(dto: CreateQuizDto, actor: Actor) {
    const section = await this.prisma.section.findUnique({
      where: { id: dto.sectionId },
      select: { id: true, schoolId: true },
    });
    if (!section) throw new NotFoundException('Section not found');
    await this.assertSectionWriteAccess(actor, section);

    if (dto.subjectId) {
      const subject = await this.prisma.subject.findUnique({
        where: { id: dto.subjectId },
        select: { schoolId: true },
      });
      if (!subject || subject.schoolId !== section.schoolId) {
        throw new BadRequestException('Invalid subject for this section');
      }
    }

    (dto.questions ?? []).forEach((q) => this.validateQuestionShape(q));

    const quiz = await this.prisma.$transaction(async (tx) => {
      const created = await tx.quiz.create({
        data: {
          schoolId: section.schoolId,
          sectionId: section.id,
          subjectId: dto.subjectId ?? null,
          title: dto.title,
          description: dto.description ?? null,
          durationMins: dto.durationMins ?? null,
          createdByUserId: actor.userId,
        },
      });
      if (dto.questions && dto.questions.length > 0) {
        await tx.question.createMany({
          data: dto.questions.map((q, i) => ({
            quizId: created.id,
            type: q.type as any,
            text: q.text,
            options: (q.options ?? null) as any,
            correctAnswer: q.correctAnswer as any,
            points: q.points ?? 1,
            order: q.order ?? i,
          })),
        });
      }
      return created;
    });

    return this.getQuizForAuthor(quiz.id, actor);
  }

  async addQuestion(quizId: string, dto: AddQuestionDto, actor: Actor) {
    const quiz = await this.loadQuizWithSection(quizId);
    await this.assertSectionWriteAccess(actor, quiz.section);
    this.validateQuestionShape(dto);

    const last = await this.prisma.question.findFirst({
      where: { quizId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const nextOrder = dto.order ?? (last ? last.order + 1 : 0);

    await this.prisma.question.create({
      data: {
        quizId,
        type: dto.type as any,
        text: dto.text,
        options: (dto.options ?? null) as any,
        correctAnswer: dto.correctAnswer as any,
        points: dto.points ?? 1,
        order: nextOrder,
      },
    });
    return this.getQuizForAuthor(quizId, actor);
  }

  // ---- import ------------------------------------------------------------

  /** The starter file. Served from the API so template and parser can't drift. */
  importTemplate(): string {
    return buildImportTemplateCsv();
  }

  /**
   * Validates the file and returns what WOULD be created. Touches no table —
   * that is the whole point: a teacher sees every row error before anything is
   * written, so a partial quiz is impossible by construction.
   */
  async importPreview(
    dto: ImportQuizDto,
    file: { buffer: Buffer; mimetype?: string } | undefined,
    actor: Actor,
  ) {
    const section = await this.resolveImportSection(dto, actor);
    const { questions, errors } = parseQuizCsv(this.readImportCsv(file));
    return {
      quiz: {
        sectionId: section.id,
        subjectId: dto.subjectId ?? null,
        title: dto.title,
        durationMins: dto.durationMins ?? null,
      },
      questions,
      errors,
      totalRows: questions.length + errors.length,
      canImport: errors.length === 0 && questions.length > 0,
    };
  }

  /**
   * Re-parses and re-validates the SAME file rather than trusting a preview
   * token, so a tampered or stale payload cannot bypass the checks, then
   * delegates to `createQuiz` — one transaction, one `createMany`, and no
   * second copy of the creation logic.
   */
  async importCommit(
    dto: ImportQuizDto,
    file: { buffer: Buffer; mimetype?: string } | undefined,
    actor: Actor,
  ) {
    await this.resolveImportSection(dto, actor);
    const { questions, errors } = parseQuizCsv(this.readImportCsv(file));

    if (errors.length > 0) {
      throw new BadRequestException({
        message: `The file has ${errors.length} problem(s). Nothing was imported.`,
        errors,
      });
    }
    if (questions.length === 0) {
      throw new BadRequestException('The file contains no questions');
    }
    // Same guard the manual path uses, so import can never create a shape the
    // API would otherwise reject.
    questions.forEach((q) => this.validateQuestionShape(q));

    return this.createQuiz(
      {
        sectionId: dto.sectionId,
        subjectId: dto.subjectId,
        title: dto.title,
        description: dto.description,
        durationMins: dto.durationMins,
        questions,
      } as CreateQuizDto,
      actor,
    );
  }

  /** Import authorization is identical to creating a quiz by hand. */
  private async resolveImportSection(dto: ImportQuizDto, actor: Actor) {
    const section = await this.prisma.section.findUnique({
      where: { id: dto.sectionId },
      select: { id: true, schoolId: true },
    });
    if (!section) throw new NotFoundException('Section not found');
    await this.assertSectionWriteAccess(actor, section);
    return section;
  }

  /** MIME and size are checked against the real buffer, never the declaration. */
  private readImportCsv(
    file: { buffer: Buffer; mimetype?: string } | undefined,
  ): string {
    if (!file?.buffer) throw new BadRequestException('A CSV file is required');
    if (file.mimetype && !IMPORT_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}" — upload a .csv`,
      );
    }
    if (file.buffer.length === 0) {
      throw new BadRequestException('The file is empty');
    }
    if (file.buffer.length > MAX_IMPORT_BYTES) {
      throw new BadRequestException(
        `The file exceeds the ${MAX_IMPORT_BYTES / 1024 / 1024}MB limit`,
      );
    }
    // Strip a UTF-8 BOM — Excel writes one and it would corrupt the first header.
    return file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  }

  // ---- editing a draft ---------------------------------------------------

  /**
   * The single editability rule, shared by every mutating edit route.
   * The attempt check is belt-and-braces — publish is the only way to reach a
   * student, so an unpublished quiz should never have attempts — but editing a
   * quiz that has them would silently rescore submitted work (`QuizAttempt`
   * stores answers keyed by question id, with score/maxScore already computed),
   * and one `count` is cheap against that.
   */
  private async assertEditable(quiz: { id: string; isPublished: boolean }) {
    if (quiz.isPublished) {
      throw new ConflictException('A published quiz cannot be edited');
    }
    const attempts = await this.prisma.quizAttempt.count({
      where: { quizId: quiz.id },
    });
    if (attempts > 0) {
      throw new ConflictException(
        'A quiz that students have started cannot be edited',
      );
    }
  }

  async updateQuiz(quizId: string, dto: UpdateQuizDto, actor: Actor) {
    const quiz = await this.loadQuizWithSection(quizId);
    await this.assertSectionWriteAccess(actor, quiz.section);
    await this.assertEditable(quiz);

    if (dto.subjectId) {
      const subject = await this.prisma.subject.findUnique({
        where: { id: dto.subjectId },
        select: { schoolId: true },
      });
      if (!subject || subject.schoolId !== quiz.schoolId) {
        throw new BadRequestException('Invalid subject for this section');
      }
    }

    await this.prisma.quiz.update({
      where: { id: quizId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.durationMins !== undefined && {
          durationMins: dto.durationMins,
        }),
        ...(dto.subjectId !== undefined && { subjectId: dto.subjectId }),
      },
    });
    return this.getQuizForAuthor(quizId, actor);
  }

  async updateQuestion(
    quizId: string,
    questionId: string,
    dto: UpdateQuestionDto,
    actor: Actor,
  ) {
    const quiz = await this.loadQuizWithSection(quizId);
    await this.assertSectionWriteAccess(actor, quiz.section);
    await this.assertEditable(quiz);

    const existing = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: {
        id: true,
        quizId: true,
        type: true,
        text: true,
        options: true,
        correctAnswer: true,
      },
    });
    // Scoped by quiz, so a question id from another quiz reads as not-found.
    if (!existing || existing.quizId !== quizId) {
      throw new NotFoundException('Question not found');
    }

    // Validate the MERGED question, never the patch alone: changing only
    // `correctAnswer` still has to agree with the options already stored.
    // `??` not `||` — `false` is a valid TRUE_FALSE answer.
    const merged = {
      type: (dto.type ?? existing.type) as QuestionType,
      text: dto.text ?? existing.text,
      options: dto.options ?? existing.options,
      correctAnswer: dto.correctAnswer ?? existing.correctAnswer,
    } as CreateQuestionInput;
    this.validateQuestionShape(merged);

    await this.prisma.question.update({
      where: { id: questionId },
      data: {
        ...(dto.type !== undefined && { type: dto.type as any }),
        ...(dto.text !== undefined && { text: dto.text }),
        ...(dto.options !== undefined && { options: dto.options as any }),
        ...(dto.correctAnswer !== undefined && {
          correctAnswer: dto.correctAnswer as any,
        }),
        ...(dto.points !== undefined && { points: dto.points }),
        // Switching to TRUE_FALSE drops stale MCQ options rather than leaving
        // them on a row where they mean nothing.
        ...(merged.type === QuestionType.TRUE_FALSE && { options: null }),
      },
    });
    return this.getQuizForAuthor(quizId, actor);
  }

  async deleteQuestion(quizId: string, questionId: string, actor: Actor) {
    const quiz = await this.loadQuizWithSection(quizId);
    await this.assertSectionWriteAccess(actor, quiz.section);
    await this.assertEditable(quiz);

    const existing = await this.prisma.question.findUnique({
      where: { id: questionId },
      select: { id: true, quizId: true },
    });
    if (!existing || existing.quizId !== quizId) {
      throw new NotFoundException('Question not found');
    }

    // Deleting the last question is allowed — `publish` already refuses a quiz
    // with none, so an empty draft can never reach a student.
    await this.prisma.question.delete({ where: { id: questionId } });
    return this.getQuizForAuthor(quizId, actor);
  }

  async reorderQuestions(
    quizId: string,
    dto: ReorderQuestionsDto,
    actor: Actor,
  ) {
    const quiz = await this.loadQuizWithSection(quizId);
    await this.assertSectionWriteAccess(actor, quiz.section);
    await this.assertEditable(quiz);

    const current = await this.prisma.question.findMany({
      where: { quizId },
      select: { id: true },
    });
    const currentIds = new Set(current.map((q) => q.id));
    const givenIds = new Set(dto.questionIds);
    // The list must be the quiz's questions exactly once each — that is what
    // makes a partial reorder impossible.
    if (
      givenIds.size !== dto.questionIds.length ||
      givenIds.size !== currentIds.size ||
      dto.questionIds.some((id) => !currentIds.has(id))
    ) {
      throw new BadRequestException(
        'questionIds must list every question of this quiz exactly once',
      );
    }

    await this.prisma.$transaction(
      dto.questionIds.map((id, index) =>
        this.prisma.question.update({ where: { id }, data: { order: index } }),
      ),
    );
    return this.getQuizForAuthor(quizId, actor);
  }

  async publish(quizId: string, actor: Actor) {
    const quiz = await this.loadQuizWithSection(quizId);
    await this.assertSectionWriteAccess(actor, quiz.section);
    const questionCount = await this.prisma.question.count({
      where: { quizId },
    });
    if (questionCount === 0) {
      throw new BadRequestException('Cannot publish a quiz with no questions');
    }
    await this.prisma.quiz.update({
      where: { id: quizId },
      data: { isPublished: true },
    });
    // Notify students only on the first publish (guards re-publish).
    if (!quiz.isPublished) await this.notifyQuizPublished(quiz);
    return this.getQuizForAuthor(quizId, actor);
  }

  /** Fan-out a "new quiz" notification to the section's students. */
  private async notifyQuizPublished(quiz: {
    id: string;
    title: string;
    section: { id: string };
  }) {
    const studentIds = await sectionStudentIds(this.prisma, quiz.section.id);
    const userIds = await studentUserIds(this.prisma, studentIds);
    if (!userIds.length) return;
    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds,
      type: 'QUIZ_PUBLISHED',
      title: 'New quiz',
      body: `"${quiz.title}" is now available.`,
      link: `/quizzes/${quiz.id}`,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);
  }

  async listQuizzes(actor: Actor, query: FindQuizzesQueryDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = Math.min(
      query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const where: any = {};
    if (actor.role === Role.SUPER_ADMIN) {
      if (query.schoolId) where.schoolId = query.schoolId;
    } else if (actor.role === Role.SCHOOL_ADMIN) {
      if (!actor.schoolId) throw new ForbiddenException('No school context');
      where.schoolId = actor.schoolId;
    } else if (actor.role === Role.TEACHER) {
      if (!actor.schoolId) throw new ForbiddenException('No school context');
      where.schoolId = actor.schoolId;
      const myTeacherId = await this.teacherProfileIdFor(actor);
      const taught = await this.prisma.sectionSubject.findMany({
        where: { teacherId: myTeacherId ?? '' },
        select: { sectionId: true },
      });
      where.sectionId = { in: taught.map((t) => t.sectionId) };
    } else {
      throw new ForbiddenException('Not allowed');
    }
    if (query.sectionId) where.sectionId = query.sectionId;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.quiz.count({ where }),
      this.prisma.quiz.findMany({
        where,
        include: {
          subject: { select: { id: true, name: true } },
          section: { select: { id: true, name: true } },
          _count: { select: { questions: true, attempts: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, items: rows };
  }

  /** Full quiz incl. correctAnswer — teacher/admin authoring view only. */
  async getQuizForAuthor(quizId: string, actor: Actor) {
    const quiz = await this.prisma.quiz.findUnique({
      where: { id: quizId },
      include: {
        subject: { select: { id: true, name: true } },
        section: { select: { id: true, name: true, schoolId: true } },
        questions: { orderBy: { order: 'asc' } },
      },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');
    this.enforceScope(actor, quiz.schoolId);
    if (actor.role === Role.TEACHER) {
      await this.assertSectionWriteAccess(actor, quiz.section);
    }
    return quiz;
  }

  async getResults(quizId: string, actor: Actor, query: FindQuizzesQueryDto) {
    const quiz = await this.loadQuizWithSection(quizId);
    await this.assertSectionWriteAccess(actor, quiz.section);

    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = Math.min(
      query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.quizAttempt.count({ where: { quizId } }),
      this.prisma.quizAttempt.findMany({
        where: { quizId },
        include: {
          student: { select: { id: true, fullName: true, rollNo: true } },
        },
        orderBy: { submittedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, items: rows };
  }

  // ---- student -----------------------------------------------------------

  async available(actor: Actor) {
    const student = await this.studentProfileFor(actor);
    if (!student) throw new ForbiddenException('Student profile not found');

    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId: student.id, status: 'ACTIVE' },
      select: { sectionId: true },
    });
    const sectionIds = enrollments.map((e) => e.sectionId);
    if (sectionIds.length === 0) return [];

    const quizzes = await this.prisma.quiz.findMany({
      where: { sectionId: { in: sectionIds }, isPublished: true },
      include: {
        subject: { select: { id: true, name: true } },
        section: { select: { id: true, name: true } },
        _count: { select: { questions: true } },
        attempts: {
          where: { studentId: student.id },
          select: { id: true, status: true, score: true, maxScore: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // No correctAnswer here — this is only quiz metadata.
    return quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      description: q.description,
      durationMins: q.durationMins,
      subject: q.subject,
      section: q.section,
      questionCount: q._count.questions,
      attempt: q.attempts[0] ?? null,
    }));
  }

  async startAttempt(quizId: string, actor: Actor) {
    const student = await this.studentProfileFor(actor);
    if (!student) throw new ForbiddenException('Student profile not found');

    const quiz = await this.prisma.quiz.findUnique({
      where: { id: quizId },
      include: { questions: { orderBy: { order: 'asc' } } },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');
    this.enforceScope(actor, quiz.schoolId);
    if (!quiz.isPublished) {
      throw new ForbiddenException('Quiz is not available');
    }

    const enrolled = await this.prisma.enrollment.findFirst({
      where: {
        studentId: student.id,
        sectionId: quiz.sectionId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (!enrolled) {
      throw new ForbiddenException('You are not enrolled in this quiz');
    }

    let attempt = await this.prisma.quizAttempt.findUnique({
      where: { quizId_studentId: { quizId, studentId: student.id } },
    });
    if (attempt && attempt.status !== QuizAttemptStatus.IN_PROGRESS) {
      throw new BadRequestException('You have already completed this quiz');
    }
    if (!attempt) {
      attempt = await this.prisma.quizAttempt.create({
        data: { quizId, studentId: student.id, answers: {} },
      });
    }

    return {
      attemptId: attempt.id,
      quiz: {
        id: quiz.id,
        title: quiz.title,
        description: quiz.description,
        durationMins: quiz.durationMins,
      },
      questions: this.sanitizeQuestions(quiz.questions), // no correctAnswer
    };
  }

  async submitAttempt(attemptId: string, dto: SubmitAttemptDto, actor: Actor) {
    const student = await this.studentProfileFor(actor);
    if (!student) throw new ForbiddenException('Student profile not found');

    const attempt = await this.prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: { quiz: { include: { questions: true } } },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== student.id) {
      throw new ForbiddenException('Not your attempt');
    }
    this.enforceScope(actor, attempt.quiz.schoolId);
    if (attempt.status !== QuizAttemptStatus.IN_PROGRESS) {
      throw new BadRequestException('This attempt was already submitted');
    }

    const { score, maxScore } = this.scoreAttempt(
      attempt.quiz.questions,
      dto.answers ?? {},
    );

    const updated = await this.prisma.quizAttempt.update({
      where: { id: attemptId },
      data: {
        answers: (dto.answers ?? {}) as any,
        score,
        maxScore,
        status: QuizAttemptStatus.GRADED,
        submittedAt: new Date(),
      },
    });

    // Notify the student + their parents of the score, and the teacher that the
    // quiz was completed (decoupled via the event bus).
    const parents = await parentUserIds(this.prisma, [student.id]);
    this.eventEmitter.emit(NOTIFICATION_CREATE, {
      userIds: [actor.userId, ...parents].filter((id): id is string => !!id),
      type: 'QUIZ_GRADED',
      title: `Quiz completed: ${attempt.quiz.title}`,
      body: `Scored ${score}/${maxScore} on "${attempt.quiz.title}".`,
      link: `/quizzes/${attempt.quiz.id}`,
      notifyPreferenceKey: 'notifyGrades',
    } as NotificationCreateEvent);

    if (attempt.quiz.createdByUserId) {
      this.eventEmitter.emit(NOTIFICATION_CREATE, {
        userIds: [attempt.quiz.createdByUserId],
        type: 'QUIZ_SUBMITTED',
        title: 'Quiz completed',
        body: `A student completed "${attempt.quiz.title}".`,
        link: `/quizzes/${attempt.quiz.id}/results`,
        notifyPreferenceKey: 'notifyGrades',
      } as NotificationCreateEvent);
    }

    return {
      attemptId: updated.id,
      status: updated.status,
      score,
      maxScore,
    };
  }

  /** View a single attempt. correctAnswer is only exposed once GRADED. */
  async getAttempt(attemptId: string, actor: Actor) {
    const attempt = await this.prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: {
        quiz: { include: { questions: { orderBy: { order: 'asc' } } } },
        student: { select: { id: true, userId: true, fullName: true } },
      },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    this.enforceScope(actor, attempt.quiz.schoolId);

    // Object-level access.
    if (actor.role === Role.STUDENT) {
      if (attempt.student.userId !== actor.userId) {
        throw new ForbiddenException('Not your attempt');
      }
    } else if (actor.role === Role.PARENT) {
      const link = await this.prisma.parentStudent.findFirst({
        where: {
          studentId: attempt.studentId,
          parent: { userId: actor.userId ?? undefined },
        },
        select: { studentId: true },
      });
      if (!link) throw new ForbiddenException('Not your child');
    } else if (actor.role === Role.TEACHER) {
      await this.assertSectionWriteAccess(actor, {
        id: attempt.quiz.sectionId,
        schoolId: attempt.quiz.schoolId,
      });
    }

    const graded = attempt.status === QuizAttemptStatus.GRADED;
    const answers = (attempt.answers as Record<string, unknown>) ?? {};

    return {
      id: attempt.id,
      status: attempt.status,
      score: attempt.score,
      maxScore: attempt.maxScore,
      submittedAt: attempt.submittedAt,
      student: {
        id: attempt.student.id,
        fullName: attempt.student.fullName,
      },
      quiz: { id: attempt.quiz.id, title: attempt.quiz.title },
      questions: attempt.quiz.questions.map((q) => ({
        id: q.id,
        type: q.type,
        text: q.text,
        options: q.options ?? null,
        points: q.points,
        order: q.order,
        yourAnswer: answers[q.id] ?? null,
        // Only reveal the key + correctness after the attempt is graded.
        ...(graded
          ? {
              correctAnswer: q.correctAnswer,
              correct: this.isCorrect(q, answers[q.id]),
            }
          : {}),
      })),
    };
  }

  // ---- shared ------------------------------------------------------------

  private async loadQuizWithSection(quizId: string) {
    const quiz = await this.prisma.quiz.findUnique({
      where: { id: quizId },
      include: { section: { select: { id: true, schoolId: true } } },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');
    return quiz;
  }
}
