const fs = require('fs');
const path = require('path');

const bearerTemplate = {
  type: 'bearer',
  bearer: [{ key: 'token', value: '{{accessToken}}' }],
};

const authHeader = { key: 'Authorization', value: 'Bearer {{accessToken}}' };
const jsonHeader = { key: 'Content-Type', value: 'application/json' };

const withAuth = () => JSON.parse(JSON.stringify(bearerTemplate));
const withHeader = (header) => ({ ...header });

const makeUrl = (segments, query) => ({
  raw: `{{baseUrl}}/${segments.map((seg) => seg).join('/')}${query && query.length ? '?' + query.map((q) => `${q.key}=${q.value}`).join('&') : ''}`,
  host: ['{{baseUrl}}'],
  path: segments,
  ...(query && query.length ? { query } : {}),
});

const makeRequest = (options) => {
  const {
    name,
    method,
    segments,
    query,
    body,
    formdata,
    auth = true,
    headers = [],
    description,
  } = options;

  const request = {
    name,
    request: {
      method,
      ...(auth ? { auth: withAuth() } : {}),
      header: auth ? [withHeader(authHeader), ...headers] : headers,
      url: makeUrl(segments, query),
    },
  };

  if (formdata) {
    request.request.body = {
      mode: 'formdata',
      formdata,
    };
  } else if (body) {
    request.request.body = {
      mode: 'raw',
      raw: body,
    };
    if (!headers.find((h) => h.key === 'Content-Type')) {
      request.request.header.push(withHeader(jsonHeader));
    }
  }

  if (description) {
    request.request.description = description;
  }

  return request;
};

const authGroup = {
  name: 'Auth',
  item: [
    makeRequest({
      name: 'Login',
      method: 'POST',
      segments: ['auth', 'login'],
      auth: false,
      headers: [withHeader(jsonHeader)],
      body: `{
  "email": "admin@example.com",
  "password": "changeme123"
}`,
    }),
    makeRequest({
      name: 'Refresh Token',
      method: 'POST',
      segments: ['auth', 'refresh'],
      auth: false,
      headers: [withHeader(jsonHeader)],
      body: `{
  "refreshToken": "{{refreshToken}}"
}`,
    }),
    makeRequest({
      name: 'Logout',
      method: 'POST',
      segments: ['auth', 'logout'],
      auth: true,
    }),
    makeRequest({
      name: 'Me',
      method: 'GET',
      segments: ['auth', 'me'],
      auth: true,
    }),
  ],
};

const schoolsGroup = {
  name: 'Schools',
  item: [
    makeRequest({
      name: 'Create School',
      method: 'POST',
      segments: ['schools'],
      body: `{
  "name": "Springfield Elementary",
  "code": "SFE",
  "addressLine1": "742 Evergreen Terrace",
  "city": "Springfield",
  "state": "IL",
  "postalCode": "62704",
  "country": "USA",
  "phone": "+15550000000",
  "email": "contact@sfe.edu",
  "website": "https://sfe.edu"
}`,
    }),
    makeRequest({ name: 'List Schools', method: 'GET', segments: ['schools'] }),
    makeRequest({
      name: 'Get School',
      method: 'GET',
      segments: ['schools', '{{schoolId}}'],
    }),
    makeRequest({
      name: 'Update School',
      method: 'PATCH',
      segments: ['schools', '{{schoolId}}'],
      body: `{
  "name": "Springfield Elementary (Updated)",
  "phone": "+15550001111",
  "website": "https://school.example.com"
}`,
    }),
    makeRequest({
      name: 'Delete School',
      method: 'DELETE',
      segments: ['schools', '{{schoolId}}'],
    }),
  ],
};

const usersGroup = {
  name: 'Users',
  item: [
    makeRequest({
      name: 'Create User',
      method: 'POST',
      segments: ['users'],
      body: `{
  "email": "teacher1@example.com",
  "password": "changeme123",
  "role": "TEACHER",
  "schoolId": "{{schoolId}}",
  "fullName": "John Smith",
  "phone": "+15550001111"
}`,
    }),
    makeRequest({ name: 'List Users', method: 'GET', segments: ['users'] }),
    makeRequest({ name: 'Get User', method: 'GET', segments: ['users', '{{userId}}'] }),
    makeRequest({
      name: 'Update User',
      method: 'PATCH',
      segments: ['users', '{{userId}}'],
      body: `{
  "fullName": "John Smith Jr.",
  "phone": "+15550002222"
}`,
    }),
    makeRequest({
      name: 'Set Active State',
      method: 'PATCH',
      segments: ['users', '{{userId}}', 'active'],
      body: `{
  "isActive": true
}`,
    }),
    makeRequest({ name: 'Delete User', method: 'DELETE', segments: ['users', '{{userId}}'] }),
    makeRequest({
      name: 'Link Parent To Student',
      method: 'POST',
      segments: ['users', 'link-parent-student'],
      body: `{
  "parentProfileId": "{{parentProfileId}}",
  "studentProfileId": "{{studentProfileId}}"
}`,
    }),
    {
      name: 'Social Links',
      item: [
        makeRequest({ name: 'List Social Links', method: 'GET', segments: ['users', '{{userId}}', 'social-links'] }),
        makeRequest({
          name: 'Create Social Link',
          method: 'POST',
          segments: ['users', '{{userId}}', 'social-links'],
          body: `{
  "platform": "linkedin",
  "label": "LinkedIn",
  "url": "https://linkedin.com/in/teacher1",
  "isActive": true
}`,
        }),
        makeRequest({
          name: 'Update Social Link',
          method: 'PATCH',
          segments: ['users', '{{userId}}', 'social-links', '{{socialLinkId}}'],
          body: `{
  "label": "LinkedIn Profile",
  "isActive": false
}`,
        }),
        makeRequest({
          name: 'Delete Social Link',
          method: 'DELETE',
          segments: ['users', '{{userId}}', 'social-links', '{{socialLinkId}}'],
        }),
      ],
    },
  ],
};

const crudBlock = (resource) => [
  makeRequest(resource.create),
  makeRequest(resource.list),
  makeRequest(resource.get),
  makeRequest(resource.update),
  makeRequest(resource.remove),
];

const academicsGroup = {
  name: 'Academics',
  item: [],
};

const academicYears = {
  create: {
    name: 'Create Academic Year',
    method: 'POST',
    segments: ['academic-years'],
    body: `{
  "name": "2025-26",
  "code": "AY-2025",
  "startDate": "2025-04-01",
  "endDate": "2026-03-31",
  "schoolId": "{{schoolId}}"
}`,
  },
  list: {
    name: 'List Academic Years',
    method: 'GET',
    segments: ['academic-years'],
    query: [{ key: 'schoolId', value: '{{schoolId}}' }],
  },
  get: {
    name: 'Get Academic Year',
    method: 'GET',
    segments: ['academic-years', '{{academicYearId}}'],
  },
  update: {
    name: 'Update Academic Year',
    method: 'PATCH',
    segments: ['academic-years', '{{academicYearId}}'],
    body: `{
  "name": "2025-26 Session",
  "isActive": true
}`,
  },
  remove: {
    name: 'Delete Academic Year',
    method: 'DELETE',
    segments: ['academic-years', '{{academicYearId}}'],
  },
};

const classGrades = {
  create: {
    name: 'Create Class Grade',
    method: 'POST',
    segments: ['class-grades'],
    body: `{
  "name": "Grade 6",
  "code": "G6",
  "description": "Middle school grade",
  "schoolId": "{{schoolId}}"
}`,
  },
  list: {
    name: 'List Class Grades',
    method: 'GET',
    segments: ['class-grades'],
    query: [{ key: 'schoolId', value: '{{schoolId}}' }],
  },
  get: {
    name: 'Get Class Grade',
    method: 'GET',
    segments: ['class-grades', '{{classGradeId}}'],
  },
  update: {
    name: 'Update Class Grade',
    method: 'PATCH',
    segments: ['class-grades', '{{classGradeId}}'],
    body: `{
  "description": "Updated description",
  "isActive": true
}`,
  },
  remove: {
    name: 'Delete Class Grade',
    method: 'DELETE',
    segments: ['class-grades', '{{classGradeId}}'],
  },
};

const sections = {
  create: {
    name: 'Create Section',
    method: 'POST',
    segments: ['sections'],
    body: `{
  "classGradeId": "{{classGradeId}}",
  "name": "Section A",
  "room": "Room 204"
}`,
  },
  list: {
    name: 'List Sections',
    method: 'GET',
    segments: ['sections'],
    query: [{ key: 'classGradeId', value: '{{classGradeId}}' }],
  },
  get: {
    name: 'Get Section',
    method: 'GET',
    segments: ['sections', '{{sectionId}}'],
  },
  update: {
    name: 'Update Section',
    method: 'PATCH',
    segments: ['sections', '{{sectionId}}'],
    body: `{
  "room": "Room 205",
  "isActive": true
}`,
  },
  remove: {
    name: 'Delete Section',
    method: 'DELETE',
    segments: ['sections', '{{sectionId}}'],
  },
};

const sectionTeacherExtras = [
  makeRequest({
    name: 'List Section Teachers',
    method: 'GET',
    segments: ['sections', '{{sectionId}}', 'teachers'],
  }),
  makeRequest({
    name: 'Assign Section Teacher',
    method: 'POST',
    segments: ['sections', '{{sectionId}}', 'teachers'],
    body: `{
  "teacherId": "{{teacherId}}",
  "assignmentRole": "Homeroom",
  "isPrimary": true,
  "startDate": "2025-06-01"
}`,
  }),
  makeRequest({
    name: 'Update Section Teacher',
    method: 'PATCH',
    segments: ['sections', '{{sectionId}}', 'teachers', '{{sectionTeacherId}}'],
    body: `{
  "assignmentRole": "Co-teacher",
  "isPrimary": false,
  "endDate": "2026-03-31"
}`,
  }),
  makeRequest({
    name: 'Remove Section Teacher',
    method: 'DELETE',
    segments: ['sections', '{{sectionId}}', 'teachers', '{{sectionTeacherId}}'],
  }),
];

const subjects = {
  create: {
    name: 'Create Subject',
    method: 'POST',
    segments: ['subjects'],
    body: `{
  "name": "Mathematics",
  "code": "MATH",
  "schoolId": "{{schoolId}}"
}`,
  },
  list: {
    name: 'List Subjects',
    method: 'GET',
    segments: ['subjects'],
    query: [{ key: 'schoolId', value: '{{schoolId}}' }],
  },
  get: {
    name: 'Get Subject',
    method: 'GET',
    segments: ['subjects', '{{subjectId}}'],
  },
  update: {
    name: 'Update Subject',
    method: 'PATCH',
    segments: ['subjects', '{{subjectId}}'],
    body: `{
  "description": "Advanced math curriculum",
  "isCore": true
}`,
  },
  remove: {
    name: 'Delete Subject',
    method: 'DELETE',
    segments: ['subjects', '{{subjectId}}'],
  },
};

const students = {
  create: {
    name: 'Create Student',
    method: 'POST',
    segments: ['students'],
    body: `{
  "fullName": "Lisa Simpson",
  "admissionNo": "ADM-1001",
  "schoolId": "{{schoolId}}",
  "dob": "2015-08-12",
  "phone": "+15556660001"
}`,
  },
  list: {
    name: 'List Students',
    method: 'GET',
    segments: ['students'],
    query: [{ key: 'schoolId', value: '{{schoolId}}' }],
  },
  get: {
    name: 'Get Student',
    method: 'GET',
    segments: ['students', '{{studentId}}'],
  },
  update: {
    name: 'Update Student',
    method: 'PATCH',
    segments: ['students', '{{studentId}}'],
    body: `{
  "phone": "+15556667777",
  "addressLine1": "742 Evergreen Terrace"
}`,
  },
  remove: {
    name: 'Delete Student',
    method: 'DELETE',
    segments: ['students', '{{studentId}}'],
  },
};

const studentParentExtras = [
  makeRequest({
    name: 'List Student Parents',
    method: 'GET',
    segments: ['students', '{{studentId}}', 'parents'],
  }),
  makeRequest({
    name: 'Link Parent Profile',
    method: 'POST',
    segments: ['students', '{{studentId}}', 'parents'],
    body: `{
  "parentProfileId": "{{parentProfileId}}"
}`,
  }),
  makeRequest({
    name: 'Unlink Parent Profile',
    method: 'DELETE',
    segments: ['students', '{{studentId}}', 'parents', '{{parentProfileId}}'],
  }),
];

const enrollments = {
  create: {
    name: 'Create Enrollment',
    method: 'POST',
    segments: ['enrollments'],
    body: `{
  "studentId": "{{studentId}}",
  "sectionId": "{{sectionId}}",
  "academicYearId": "{{academicYearId}}"
}`,
  },
  list: {
    name: 'List Enrollments',
    method: 'GET',
    segments: ['enrollments'],
    query: [{ key: 'studentId', value: '{{studentId}}' }],
  },
  get: {
    name: 'Get Enrollment',
    method: 'GET',
    segments: ['enrollments', '{{enrollmentId}}'],
  },
  update: {
    name: 'Update Enrollment',
    method: 'PATCH',
    segments: ['enrollments', '{{enrollmentId}}'],
    body: `{
  "status": "COMPLETED",
  "endDate": "2026-03-31"
}`,
  },
  remove: {
    name: 'Delete Enrollment',
    method: 'DELETE',
    segments: ['enrollments', '{{enrollmentId}}'],
  },
};

const sectionSubjects = {
  create: {
    name: 'Create Section Subject',
    method: 'POST',
    segments: ['section-subjects'],
    body: `{
  "sectionId": "{{sectionId}}",
  "subjectId": "{{subjectId}}",
  "teacherId": "{{teacherId}}",
  "isPrimary": true
}`,
  },
  list: {
    name: 'List Section Subjects',
    method: 'GET',
    segments: ['section-subjects'],
    query: [{ key: 'sectionId', value: '{{sectionId}}' }],
  },
  get: {
    name: 'Get Section Subject',
    method: 'GET',
    segments: ['section-subjects', '{{sectionSubjectId}}'],
  },
  update: {
    name: 'Update Section Subject',
    method: 'PATCH',
    segments: ['section-subjects', '{{sectionSubjectId}}'],
    body: `{
  "teacherId": "{{teacherId}}",
  "schedule": "Mon/Wed 10:00"
}`,
  },
  remove: {
    name: 'Delete Section Subject',
    method: 'DELETE',
    segments: ['section-subjects', '{{sectionSubjectId}}'],
  },
};

academicsGroup.item.push(
  { name: 'Academic Years', item: crudBlock(academicYears) },
  { name: 'Class Grades', item: crudBlock(classGrades) },
  { name: 'Sections', item: [...crudBlock(sections), ...sectionTeacherExtras] },
  { name: 'Subjects', item: crudBlock(subjects) },
  { name: 'Students', item: [...crudBlock(students), ...studentParentExtras] },
  { name: 'Enrollments', item: crudBlock(enrollments) },
  { name: 'Section Subjects', item: crudBlock(sectionSubjects) },
);

const teacherCrud = {
  create: {
    name: 'Create Teacher',
    method: 'POST',
    segments: ['teachers'],
    body: `{
  "fullName": "Edna Krabappel",
  "employeeCode": "EMP-001",
  "schoolId": "{{schoolId}}",
  "email": "edna.krabappel@sfe.edu",
  "phone": "+1555010001"
}`,
  },
  list: {
    name: 'List Teachers',
    method: 'GET',
    segments: ['teachers'],
    query: [{ key: 'schoolId', value: '{{schoolId}}' }],
  },
  get: {
    name: 'Get Teacher',
    method: 'GET',
    segments: ['teachers', '{{teacherId}}'],
  },
  update: {
    name: 'Update Teacher',
    method: 'PATCH',
    segments: ['teachers', '{{teacherId}}'],
    body: `{
  "designation": "Head Teacher",
  "phone": "+1555010101"
}`,
  },
  remove: {
    name: 'Delete Teacher',
    method: 'DELETE',
    segments: ['teachers', '{{teacherId}}'],
  },
};

const teacherQualifications = {
  create: {
    name: 'Create Qualification',
    method: 'POST',
    segments: ['teacher-qualifications'],
    body: `{
  "teacherId": "{{teacherId}}",
  "title": "B.Ed",
  "institution": "Springfield University",
  "completionYear": 2015
}`,
  },
  list: {
    name: 'List Qualifications',
    method: 'GET',
    segments: ['teacher-qualifications'],
    query: [{ key: 'teacherId', value: '{{teacherId}}' }],
  },
  get: {
    name: 'Get Qualification',
    method: 'GET',
    segments: ['teacher-qualifications', '{{teacherQualificationId}}'],
  },
  update: {
    name: 'Update Qualification',
    method: 'PATCH',
    segments: ['teacher-qualifications', '{{teacherQualificationId}}'],
    body: `{
  "description": "Focus on curriculum design"
}`,
  },
  remove: {
    name: 'Delete Qualification',
    method: 'DELETE',
    segments: ['teacher-qualifications', '{{teacherQualificationId}}'],
  },
};

const teacherSpecialties = {
  create: {
    name: 'Create Specialty',
    method: 'POST',
    segments: ['teacher-specialties'],
    body: `{
  "teacherId": "{{teacherId}}",
  "subjectId": "{{subjectId}}",
  "expertiseLevel": "EXPERT",
  "experienceYears": 8
}`,
  },
  list: {
    name: 'List Specialties',
    method: 'GET',
    segments: ['teacher-specialties'],
    query: [{ key: 'teacherId', value: '{{teacherId}}' }],
  },
  get: {
    name: 'Get Specialty',
    method: 'GET',
    segments: ['teacher-specialties', '{{teacherSpecialtyId}}'],
  },
  update: {
    name: 'Update Specialty',
    method: 'PATCH',
    segments: ['teacher-specialties', '{{teacherSpecialtyId}}'],
    body: `{
  "expertiseLevel": "INTERMEDIATE",
  "notes": "Available for remedial batches"
}`,
  },
  remove: {
    name: 'Delete Specialty',
    method: 'DELETE',
    segments: ['teacher-specialties', '{{teacherSpecialtyId}}'],
  },
};

const teachersGroup = {
  name: 'Teachers',
  item: [
    { name: 'Teachers CRUD', item: crudBlock(teacherCrud) },
    { name: 'Teacher Qualifications', item: crudBlock(teacherQualifications) },
    { name: 'Teacher Specialties', item: crudBlock(teacherSpecialties) },
  ],
};

const assignmentsGroup = {
  name: 'Assignments',
  item: [
    makeRequest({
      name: 'Create Assignment (Teacher)',
      method: 'POST',
      segments: ['assignments'],
      formdata: [
        { key: 'academicYearId', value: '{{academicYearId}}', type: 'text' },
        { key: 'sectionSubjectId', value: '{{sectionSubjectId}}', type: 'text' },
        { key: 'title', value: 'Algebra Homework 1', type: 'text' },
        { key: 'description', value: 'Solve questions 1-10', type: 'text' },
        { key: 'dueAt', value: '2026-01-31T23:59:59.000Z', type: 'text' },
        { key: 'maxScore', value: '10', type: 'text' },
        { key: 'attachments', type: 'file', src: [] },
      ],
      description:
        'Send multipart/form-data. Add one or more files using the key "attachments". The API uploads attachments to S3 and returns the created assignment (attachments included).',
    }),
    makeRequest({
      name: 'List Assignments (Role-Aware)',
      method: 'GET',
      segments: ['assignments'],
      query: [
        { key: 'academicYearId', value: '{{academicYearId}}' },
        { key: 'sectionSubjectId', value: '{{sectionSubjectId}}' },
      ],
    }),
    makeRequest({
      name: 'Get Assignment (Role-Aware)',
      method: 'GET',
      segments: ['assignments', '{{assignmentId}}'],
    }),
    makeRequest({
      name: 'Publish Assignment (Teacher)',
      method: 'POST',
      segments: ['assignments', '{{assignmentId}}', 'publish'],
    }),
    makeRequest({
      name: 'Close Assignment (Teacher)',
      method: 'POST',
      segments: ['assignments', '{{assignmentId}}', 'close'],
    }),
    makeRequest({
      name: 'Request Attachment Upload (Teacher)',
      method: 'POST',
      segments: ['assignments', '{{assignmentId}}', 'attachments', 'request-upload'],
      body: `{
  "fileName": "assignment-sheet.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 123456
}`,
      description:
        'Returns a presigned PUT URL (upload.method=PUT) for uploading the attachment to S3, then call Confirm Attachment to mark it READY.',
    }),
    makeRequest({
      name: 'Confirm Attachment (Teacher)',
      method: 'POST',
      segments: ['assignments', '{{assignmentId}}', 'attachments', '{{assignmentAttachmentId}}', 'confirm'],
      description: 'Marks the attachment as READY so students/parents can download it.',
    }),
    makeRequest({
      name: 'Request Attachment Download (Role-Aware)',
      method: 'GET',
      segments: ['assignments', '{{assignmentId}}', 'attachments', '{{assignmentAttachmentId}}', 'request-download'],
      query: [{ key: 'studentId', value: '{{studentProfileId}}' }],
      description:
        'Returns a presigned GET URL for downloading the attachment. For PARENT, pass studentId of their child. For STUDENT, studentId is ignored.',
    }),
    makeRequest({
      name: 'Request Upload (Student)',
      method: 'POST',
      segments: ['assignments', '{{assignmentId}}', 'submissions', 'request-upload'],
      body: `{
  "fileName": "homework1.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 123456
}`,
      description:
        'Returns a presigned PUT URL. Upload the file to S3 using the returned uploadUrl, then call Submit Submission.',
    }),
    makeRequest({
      name: 'Submit Submission (Student)',
      method: 'POST',
      segments: ['assignments', '{{assignmentId}}', 'submissions', '{{assignmentSubmissionId}}', 'submit'],
    }),
    makeRequest({
      name: 'List Submissions (Teacher)',
      method: 'GET',
      segments: ['assignments', '{{assignmentId}}', 'submissions'],
    }),
    makeRequest({
      name: 'Mark Submission (Teacher)',
      method: 'PATCH',
      segments: ['assignments', 'submissions', '{{assignmentSubmissionId}}', 'mark'],
      body: `{
  "score": 9,
  "remarks": "Good work"
}`,
    }),
    makeRequest({
      name: 'Results (Student/Parent/Teacher)',
      method: 'GET',
      segments: ['assignments', '{{assignmentId}}', 'results'],
      query: [{ key: 'studentId', value: '{{studentProfileId}}' }],
      description:
        'For STUDENT, studentId query is ignored. For PARENT/TEACHER, pass studentId to view that student\'s submission + marks (if any).',
    }),
    makeRequest({
      name: 'Request Download (Student/Parent/Teacher)',
      method: 'GET',
      segments: ['assignment-submissions', '{{assignmentSubmissionId}}', 'request-download'],
      description: 'Returns a presigned GET URL for downloading the uploaded submission from S3.',
    }),
  ],
};

const examsGroup = {
  name: 'Exams',
  item: [
    makeRequest({
      name: 'Create Exam (Teacher)',
      method: 'POST',
      segments: ['exams'],
      body: `{
  "academicYearId": "{{academicYearId}}",
  "sectionSubjectId": "{{sectionSubjectId}}",
  "title": "Mid Term - Mathematics",
  "description": "Chapters 1-5",
  "heldAt": "2026-02-10T09:00:00.000Z",
  "maxScore": 100
}`,
    }),
    makeRequest({
      name: 'List Exams (Role-Aware)',
      method: 'GET',
      segments: ['exams'],
      query: [
        { key: 'academicYearId', value: '{{academicYearId}}' },
        { key: 'sectionSubjectId', value: '{{sectionSubjectId}}' },
        { key: 'studentId', value: '{{studentProfileId}}' },
      ],
      description:
        'For PARENT, pass studentId (studentProfileId) to list exams for a child. For other roles, studentId is ignored.',
    }),
    makeRequest({
      name: 'Get Exam (Role-Aware)',
      method: 'GET',
      segments: ['exams', '{{examId}}'],
      query: [{ key: 'studentId', value: '{{studentProfileId}}' }],
      description:
        'For PARENT, pass studentId (studentProfileId) to access a child\'s exam. For other roles, studentId is ignored.',
    }),
    makeRequest({
      name: 'Update Exam (Teacher)',
      method: 'PATCH',
      segments: ['exams', '{{examId}}'],
      body: `{
  "description": "Chapters 1-6",
  "maxScore": 100
}`,
    }),
    makeRequest({
      name: 'Publish Exam (Teacher)',
      method: 'POST',
      segments: ['exams', '{{examId}}', 'publish'],
    }),
    makeRequest({
      name: 'Close Exam (Teacher)',
      method: 'POST',
      segments: ['exams', '{{examId}}', 'close'],
    }),
    makeRequest({
      name: 'Mark Exam Result (Teacher)',
      method: 'PATCH',
      segments: ['exams', '{{examId}}', 'results'],
      body: `{
  "studentId": "{{studentProfileId}}",
  "score": 78,
  "remarks": "Good"
}`,
      description: 'Upserts the result for a student in this exam.',
    }),
    makeRequest({
      name: 'Exam Results (Student/Parent/Teacher)',
      method: 'GET',
      segments: ['exams', '{{examId}}', 'results'],
      query: [{ key: 'studentId', value: '{{studentProfileId}}' }],
      description:
        'For STUDENT, studentId query is ignored. For PARENT/TEACHER, pass studentId to view that student\'s result (if any).',
    }),
  ],
};

const collection = {
  info: {
    name: 'Gradely API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description:
      'Canonical Postman collection covering Gradely NestJS endpoints (auth, schools, users, academics, teachers, assignments, exams).',
  },
  item: [authGroup, schoolsGroup, usersGroup, academicsGroup, teachersGroup, assignmentsGroup, examsGroup],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000/api' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'schoolId', value: '<school-uuid>' },
    { key: 'userId', value: '<user-uuid>' },
    { key: 'parentProfileId', value: '<parent-profile-uuid>' },
    { key: 'studentProfileId', value: '<student-profile-uuid>' },
    { key: 'academicYearId', value: '<academic-year-uuid>' },
    { key: 'classGradeId', value: '<class-grade-uuid>' },
    { key: 'sectionId', value: '<section-uuid>' },
    { key: 'sectionTeacherId', value: '<section-teacher-uuid>' },
    { key: 'subjectId', value: '<subject-uuid>' },
    { key: 'studentId', value: '<student-uuid>' },
    { key: 'enrollmentId', value: '<enrollment-uuid>' },
    { key: 'sectionSubjectId', value: '<section-subject-uuid>' },
    { key: 'teacherId', value: '<teacher-uuid>' },
    { key: 'teacherQualificationId', value: '<teacher-qualification-uuid>' },
    { key: 'teacherSpecialtyId', value: '<teacher-specialty-uuid>' },
    { key: 'socialLinkId', value: '<social-link-uuid>' },
    { key: 'assignmentId', value: '<assignment-uuid>' },
    { key: 'assignmentSubmissionId', value: '<assignment-submission-uuid>' },
    { key: 'assignmentAttachmentId', value: '<assignment-attachment-uuid>' },
    { key: 'examId', value: '<exam-uuid>' },
  ],
};

const targetPath = path.join(__dirname, '..', 'postman', 'gradely-api.postman_collection.json');
fs.writeFileSync(targetPath, JSON.stringify(collection, null, 2));
console.log('Generated collection at', targetPath);
