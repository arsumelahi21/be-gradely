import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Starting database cleanup...');

  // Delete all data in correct order to respect foreign key constraints
  // Start with tables that have foreign keys pointing to them last

  try {
    // Delete in reverse dependency order
    console.log('Deleting ExamResults...');
    await prisma.examResult.deleteMany({});

    console.log('Deleting AssignmentSubmissions...');
    await prisma.assignmentSubmission.deleteMany({});

    console.log('Deleting AssignmentAttachments...');
    await prisma.assignmentAttachment.deleteMany({});

    console.log('Deleting Assignments...');
    await prisma.assignment.deleteMany({});

    console.log('Deleting Exams...');
    await prisma.exam.deleteMany({});

    console.log('Deleting Enrollments...');
    await prisma.enrollment.deleteMany({});

    console.log('Deleting SectionSubjects...');
    await prisma.sectionSubject.deleteMany({});

    console.log('Deleting SectionTeachers...');
    await prisma.$executeRawUnsafe('DELETE FROM "SectionTeacher"');

    console.log('Deleting Sections...');
    await prisma.section.deleteMany({});

    console.log('Deleting ClassGrades...');
    await prisma.classGrade.deleteMany({});

    console.log('Deleting TeacherSubjectSpecialties...');
    await prisma.teacherSubjectSpecialty.deleteMany({});

    console.log('Deleting Subjects...');
    await prisma.subject.deleteMany({});

    console.log('Deleting AcademicYears...');
    await prisma.academicYear.deleteMany({});

    console.log('Deleting ParentStudent links...');
    await prisma.$executeRawUnsafe('DELETE FROM "ParentStudent"');

    console.log('Deleting SocialLinks...');
    await prisma.socialLink.deleteMany({});

    console.log('Deleting StudentProfiles...');
    await prisma.studentProfile.deleteMany({});

    console.log('Deleting ParentProfiles...');
    await prisma.parentProfile.deleteMany({});

    console.log('Deleting TeacherQualifications...');
    await prisma.teacherQualification.deleteMany({});

    console.log('Deleting TeacherProfiles...');
    await prisma.teacherProfile.deleteMany({});

    console.log('Deleting Schools...');
    await prisma.school.deleteMany({});

    console.log('Deleting Users...');
    await prisma.user.deleteMany({});

    console.log('✅ Database cleanup completed!');

    // Create SUPER_ADMIN user
    console.log('\n👤 Creating SUPER_ADMIN user...');

    const email = 'admin@gradely.com';
    const password = 'Admin@123';
    const fullName = 'Super Admin';
    const passwordHash = await bcrypt.hash(password, 10);

    const adminUser = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'SUPER_ADMIN',
        schoolId: null, // SUPER_ADMIN has no schoolId
        fullName,
        isActive: true,
      },
    });

    console.log('✅ SUPER_ADMIN user created successfully!');
    console.log('\n📋 Admin Credentials:');
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    console.log(`   User ID: ${adminUser.id}`);
    console.log(`   Role: ${adminUser.role}`);
    console.log('\n✨ Done!');
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

