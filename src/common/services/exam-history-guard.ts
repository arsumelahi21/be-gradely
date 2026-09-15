import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type ExamHistoryScope =
  | 'academicYear'
  | 'classGrade'
  | 'section'
  | 'subject'
  | 'sectionSubject';

const LABEL: Record<ExamHistoryScope, string> = {
  academicYear: 'academic session',
  classGrade: 'class',
  section: 'section',
  subject: 'subject',
  sectionSubject: 'subject allocation',
};

/**
 * Examinations Restrict the rows they hang from, so results outlive cleanup. Asking first
 * turns the database's generic refusal into a 409 that says why (the challan precedent).
 */
export async function assertNoExaminationHistory(
  prisma: PrismaService,
  scope: ExamHistoryScope,
  id: string,
): Promise<void> {
  let count: number;
  switch (scope) {
    case 'academicYear':
      count = await prisma.examination.count({ where: { academicYearId: id } });
      break;
    case 'classGrade':
      count = await prisma.examination.count({
        where: { OR: [{ classGradeId: id }, { section: { classGradeId: id } }] },
      });
      break;
    case 'section':
      count = await prisma.examination.count({ where: { sectionId: id } });
      break;
    case 'subject':
      count = await prisma.exam.count({ where: { sectionSubject: { subjectId: id } } });
      break;
    case 'sectionSubject':
      count = await prisma.exam.count({ where: { sectionSubjectId: id } });
      break;
  }
  if (count > 0) {
    throw new ConflictException(
      `This ${LABEL[scope]} has examination history (${count} record${count === 1 ? '' : 's'}) and can't be deleted — examinations and results must be kept.`,
    );
  }
}
