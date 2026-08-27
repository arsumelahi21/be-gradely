# Exam Module - Complete Frontend API Documentation

## Table of Contents
1. [Overview](#overview)
2. [Exam Status Flow](#exam-status-flow)
3. [Teacher APIs](#teacher-apis)
4. [Student APIs](#student-apis)
5. [Parent APIs](#parent-apis)
6. [Common Flows](#common-flows)
7. [Error Handling](#error-handling)

---

## Overview

The Exam Module allows teachers to create exams, students to view exam schedules, and teachers to mark exam results. Unlike assignments, exams don't have file submissions - they are marked directly by teachers.

### Key Differences from Assignments
- ❌ **No file uploads** - Exams don't have student submissions
- ✅ **Direct marking** - Teachers mark results directly
- ✅ **Scheduled date** - Exams have a `heldAt` date/time
- ✅ **Results only** - Students can only view results, not submit work

---

## Exam Status Flow

```
DRAFT → PUBLISHED → CLOSED
```

**Status Meanings:**
- **DRAFT**: Only creator teacher can see/edit
- **PUBLISHED**: Visible to students and parents, results can be marked
- **CLOSED**: Visible to students and parents, no new results can be marked

---

## Teacher APIs

### 1. Create Exam

**Endpoint:** `POST /api/exams`

**Authorization:** `TEACHER` only

**Request Body:**
```json
{
  "academicYearId": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
  "sectionSubjectId": "98c6bc9c-3438-4536-b56a-b6b10b74904a",
  "title": "Mid Term - Mathematics",
  "description": "Chapters 1-5",
  "heldAt": "2026-02-10T09:00:00.000Z",
  "maxScore": 100
}
```

**Field Descriptions:**
- `academicYearId` (required): UUID of the academic year
- `sectionSubjectId` (required): UUID of the section-subject
- `title` (required): Exam title
- `description` (optional): Exam description
- `heldAt` (optional): ISO date string for exam date/time
- `maxScore` (optional): Maximum score (integer ≥ 0)

**Response: `201 Created`**
```json
{
  "id": "exam-uuid-123",
  "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
  "academicYearId": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
  "sectionSubjectId": "98c6bc9c-3438-4536-b56a-b6b10b74904a",
  "createdByTeacherId": "408bd87e-06fe-4050-86d0-b72108a23044",
  "title": "Mid Term - Mathematics",
  "description": "Chapters 1-5",
  "heldAt": "2026-02-10T09:00:00.000Z",
  "maxScore": 100,
  "status": "DRAFT",
  "createdAt": "2026-01-21T10:00:00.000Z",
  "updatedAt": "2026-01-21T10:00:00.000Z",
  "sectionSubject": {
    "id": "98c6bc9c-3438-4536-b56a-b6b10b74904a",
    "sectionId": "afe23989-ac39-4562-8193-d8e272c65a86",
    "subjectId": "2e22af00-cd81-4ee0-bed5-a21c11fab53b",
    "teacherId": "408bd87e-06fe-4050-86d0-b72108a23044",
    "schedule": null,
    "isPrimary": false,
    "section": {
      "id": "afe23989-ac39-4562-8193-d8e272c65a86",
      "name": "Section 1",
      "room": "room 123",
      "classGrade": {
        "id": "765fe825-b20b-4ac7-8f48-40fb9f84a4ac",
        "name": "CLASS 5",
        "code": "CLASS-5"
      }
    },
    "subject": {
      "id": "2e22af00-cd81-4ee0-bed5-a21c11fab53b",
      "name": "Mathematics",
      "code": "MATH-001"
    },
    "teacher": {
      "id": "408bd87e-06fe-4050-86d0-b72108a23044",
      "fullName": "opf-teacher-1"
    }
  },
  "academicYear": {
    "id": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
    "name": "YEAR 2026",
    "code": "2026-2027",
    "startDate": "2026-01-01T00:00:00.000Z",
    "endDate": "2027-01-07T00:00:00.000Z"
  },
  "createdByTeacher": {
    "id": "408bd87e-06fe-4050-86d0-b72108a23044",
    "fullName": "opf-teacher-1"
  }
}
```

**Business Rules:**
- Teacher must be assigned to the section-subject
- Exam is created with status `DRAFT`
- Teacher must belong to the same school

**Errors:**
- `400 Bad Request`: Invalid academicYearId or sectionSubjectId
- `403 Forbidden`: Teacher not assigned to subject/section, or cross-school access

---

### 2. List Exams (Teacher)

**Endpoint:** `GET /api/exams`

**Authorization:** `TEACHER` only

**Query Parameters:**
- `academicYearId` (optional): Filter by academic year
- `sectionSubjectId` (optional): Filter by section-subject

**Response: `200 OK`**
```json
[
  {
    "id": "exam-uuid-123",
    "title": "Mid Term - Mathematics",
    "description": "Chapters 1-5",
    "heldAt": "2026-02-10T09:00:00.000Z",
    "maxScore": 100,
    "status": "PUBLISHED",
    "sectionSubject": {
      "section": {
        "name": "Section 1",
        "classGrade": {
          "name": "CLASS 5"
        }
      },
      "subject": {
        "name": "Mathematics"
      }
    },
    "academicYear": {
      "name": "YEAR 2026"
    },
    "createdByTeacher": {
      "fullName": "opf-teacher-1"
    }
  }
]
```

**Business Rules:**
- Returns only exams created by the logged-in teacher
- Filtered by teacher's school
- Ordered by creation date (newest first)

---

### 3. Get Exam (Teacher)

**Endpoint:** `GET /api/exams/:id`

**Authorization:** `TEACHER` only

**Response: `200 OK`**
```json
{
  "id": "exam-uuid-123",
  "title": "Mid Term - Mathematics",
  "description": "Chapters 1-5",
  "heldAt": "2026-02-10T09:00:00.000Z",
  "maxScore": 100,
  "status": "PUBLISHED",
  "sectionSubject": {
    "section": {
      "name": "Section 1",
      "classGrade": {
        "name": "CLASS 5"
      }
    },
    "subject": {
      "name": "Mathematics"
    }
  },
  "academicYear": {
    "name": "YEAR 2026"
  },
  "createdByTeacher": {
    "fullName": "opf-teacher-1"
  }
}
```

**Business Rules:**
- Only creator teacher can access
- Can access exams in any status (DRAFT, PUBLISHED, CLOSED)

---

### 4. Update Exam

**Endpoint:** `PATCH /api/exams/:id`

**Authorization:** `TEACHER` only

**Request Body:**
```json
{
  "title": "Mid Term - Mathematics (Updated)",
  "description": "Chapters 1-6",
  "heldAt": "2026-02-15T09:00:00.000Z",
  "maxScore": 120,
  "status": "PUBLISHED"
}
```

**Field Descriptions:**
- All fields are optional
- `status`: Can be `DRAFT`, `PUBLISHED`, or `CLOSED`

**Response: `200 OK`**
```json
{
  "id": "exam-uuid-123",
  "title": "Mid Term - Mathematics (Updated)",
  "description": "Chapters 1-6",
  "heldAt": "2026-02-15T09:00:00.000Z",
  "maxScore": 120,
  "status": "PUBLISHED",
  "updatedAt": "2026-01-21T11:00:00.000Z",
  // ... rest of exam data
}
```

**Business Rules:**
- Only creator teacher can update
- Can update status directly or use publish/close endpoints

---

### 5. Publish Exam

**Endpoint:** `POST /api/exams/:id/publish`

**Authorization:** `TEACHER` only

**Request Body:** None

**Response: `200 OK`**
```json
{
  "id": "exam-uuid-123",
  "status": "PUBLISHED",
  "updatedAt": "2026-01-21T11:00:00.000Z",
  // ... rest of exam data
}
```

**Business Rules:**
- Sets status to `PUBLISHED`
- Makes exam visible to students and parents
- Only creator teacher can publish

---

### 6. Close Exam

**Endpoint:** `POST /api/exams/:id/close`

**Authorization:** `TEACHER` only

**Request Body:** None

**Response: `200 OK`**
```json
{
  "id": "exam-uuid-123",
  "status": "CLOSED",
  "updatedAt": "2026-01-21T12:00:00.000Z",
  // ... rest of exam data
}
```

**Business Rules:**
- Sets status to `CLOSED`
- Exam remains visible but indicates it's completed
- Only creator teacher can close

---

### 7. Mark Exam Result

**Endpoint:** `PATCH /api/exams/:id/results`

**Authorization:** `TEACHER` only

**Request Body:**
```json
{
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "score": 78,
  "grade": "B+",
  "rank": 5,
  "remarks": "Good performance, but needs improvement in algebra"
}
```

**Field Descriptions:**
- `studentId` (required): UUID of student profile
- `score` (optional): Integer ≥ 0, cannot exceed maxScore
- `grade` (optional): String grade (e.g., "A+", "B", "C-")
- `rank` (optional): Integer ≥ 1, student's rank in the exam
- `remarks` (optional): String comments

**Response: `200 OK`**
```json
{
  "id": "result-uuid-456",
  "examId": "exam-uuid-123",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "score": 78,
  "grade": "B+",
  "rank": 5,
  "remarks": "Good performance, but needs improvement in algebra",
  "markedAt": "2026-02-11T10:00:00.000Z",
  "createdAt": "2026-02-11T10:00:00.000Z",
  "updatedAt": "2026-02-11T10:00:00.000Z"
}
```

**Business Rules:**
- Only creator teacher can mark
- Student must be enrolled in the exam's section
- Score cannot exceed exam's maxScore
- Uses upsert - creates new result or updates existing
- Can mark multiple times (updates existing result)

**Errors:**
- `400 Bad Request`: Score exceeds maxScore, or studentId missing
- `403 Forbidden`: Not creator teacher, or student not enrolled
- `404 Not Found`: Exam not found

---

### 8. List All Exam Results (Teacher)

**Endpoint:** `GET /api/exams/:id/results`

**Authorization:** `TEACHER` only

**Query Parameters:** None (to list all results)

**Response: `200 OK`**
```json
[
  {
    "student": {
      "id": "00ed8713-fc82-4819-8b45-1031933aabe0",
      "userId": "user-uuid-123",
      "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
      "fullName": "John Doe",
      "rollNumber": "ST001",
      "isActive": true
    },
    "result": {
      "id": "result-uuid-456",
      "examId": "exam-uuid-123",
      "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
      "score": 78,
      "grade": "B+",
      "rank": 5,
      "remarks": "Good performance",
      "markedAt": "2026-02-11T10:00:00.000Z",
      "createdAt": "2026-02-11T10:00:00.000Z",
      "updatedAt": "2026-02-11T10:00:00.000Z"
    }
  },
  {
    "student": {
      "id": "student-uuid-789",
      "fullName": "Jane Smith",
      "rollNumber": "ST002"
    },
    "result": null
  }
]
```

**Business Rules:**
- Only creator teacher can view
- Returns all enrolled students with their results (or `null` if not marked)
- Shows which students have been marked and which haven't
- Ordered by enrollment creation date (newest first)

---

### 9. List Enrolled Students (Teacher)

**Endpoint:** `GET /api/exams/:id/students`

**Authorization:** `TEACHER` only

**Response: `200 OK`**
```json
[
  {
    "id": "enrollment-uuid-123",
    "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "sectionId": "afe23989-ac39-4562-8193-d8e272c65a86",
    "academicYearId": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
    "status": "ACTIVE",
    "startDate": "2026-01-01T00:00:00.000Z",
    "endDate": null,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "student": {
      "id": "00ed8713-fc82-4819-8b45-1031933aabe0",
      "userId": "user-uuid-123",
      "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
      "fullName": "John Doe",
      "rollNumber": "ST001",
      "isActive": true
    },
    "section": {
      "id": "afe23989-ac39-4562-8193-d8e272c65a86",
      "name": "Section 1",
      "room": "room 123",
      "classGrade": {
        "id": "765fe825-b20b-4ac7-8f48-40fb9f84a4ac",
        "name": "CLASS 5",
        "code": "CLASS-5"
      }
    },
    "academicYear": {
      "id": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
      "name": "YEAR 2026",
      "code": "2026-2027"
    }
  }
]
```

**Business Rules:**
- Only creator teacher can view
- Returns all students enrolled in the exam's section for the exam's academic year
- Only includes ACTIVE enrollments
- Ordered by enrollment creation date (newest first)
- Use this to know which students should take the exam

---

### 10. View Exam Result (Teacher - Specific Student)

**Endpoint:** `GET /api/exams/:id/results?studentId={studentProfileId}`

**Authorization:** `TEACHER` only

**Query Parameters:**
- `studentId` (required): UUID of student profile

**Response: `200 OK`**
```json
{
  "examId": "exam-uuid-123",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "result": {
    "id": "result-uuid-456",
    "examId": "exam-uuid-123",
    "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "score": 78,
    "grade": "B+",
    "rank": 5,
    "remarks": "Good performance",
    "markedAt": "2026-02-11T10:00:00.000Z",
    "createdAt": "2026-02-11T10:00:00.000Z",
    "updatedAt": "2026-02-11T10:00:00.000Z",
    "student": {
      "id": "00ed8713-fc82-4819-8b45-1031933aabe0",
      "fullName": "John Doe",
      "rollNumber": "ST001"
    }
  }
}
```

**If no result yet:**
```json
{
  "examId": "exam-uuid-123",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "result": null
}
```

**Business Rules:**
- Only creator teacher can view
- `studentId` is required
- Returns `null` if result not marked yet
- Includes student information in response

---

## Student APIs

### 1. List Exams (Student)

**Endpoint:** `GET /api/exams`

**Authorization:** `STUDENT` only

**Query Parameters:**
- `academicYearId` (optional): Filter by academic year
- `sectionSubjectId` (optional): Filter by section-subject

**Response: `200 OK`**
```json
[
  {
    "id": "exam-uuid-123",
    "title": "Mid Term - Mathematics",
    "description": "Chapters 1-5",
    "heldAt": "2026-02-10T09:00:00.000Z",
    "maxScore": 100,
    "status": "PUBLISHED",
    "sectionSubject": {
      "section": {
        "name": "Section 1",
        "classGrade": {
          "name": "CLASS 5"
        }
      },
      "subject": {
        "name": "Mathematics"
      }
    },
    "academicYear": {
      "name": "YEAR 2026"
    },
    "createdByTeacher": {
      "fullName": "opf-teacher-1"
    }
  }
]
```

**Business Rules:**
- Only shows PUBLISHED or CLOSED exams
- Only shows exams for sections student is enrolled in
- Ordered by creation date (newest first)

---

### 2. Get Exam (Student)

**Endpoint:** `GET /api/exams/:id`

**Authorization:** `STUDENT` only

**Response: `200 OK`**
```json
{
  "id": "exam-uuid-123",
  "title": "Mid Term - Mathematics",
  "description": "Chapters 1-5",
  "heldAt": "2026-02-10T09:00:00.000Z",
  "maxScore": 100,
  "status": "PUBLISHED",
  "sectionSubject": {
    "section": {
      "name": "Section 1",
      "classGrade": {
        "name": "CLASS 5"
      }
    },
    "subject": {
      "name": "Mathematics"
    }
  },
  "academicYear": {
    "name": "YEAR 2026"
  },
  "createdByTeacher": {
    "fullName": "opf-teacher-1"
  }
}
```

**Business Rules:**
- Only PUBLISHED or CLOSED exams are accessible
- Student must be enrolled in the exam's section

---

### 3. View Exam Result (Student)

**Endpoint:** `GET /api/exams/:id/results`

**Authorization:** `STUDENT` only

**Query Parameters:** None (automatically uses logged-in student)

**Response: `200 OK`**
```json
{
  "examId": "exam-uuid-123",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "result": {
    "id": "result-uuid-456",
    "examId": "exam-uuid-123",
    "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "score": 78,
    "grade": "B+",
    "rank": 5,
    "remarks": "Good performance",
    "markedAt": "2026-02-11T10:00:00.000Z",
    "createdAt": "2026-02-11T10:00:00.000Z",
    "updatedAt": "2026-02-11T10:00:00.000Z"
  }
}
```

**If no result yet:**
```json
{
  "examId": "exam-uuid-123",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "result": null
}
```

**Business Rules:**
- Student can only view their own result
- Exam must be PUBLISHED or CLOSED
- Returns `null` if result not marked yet

---

## Parent APIs

### 1. List Exams (Parent)

**Endpoint:** `GET /api/exams?studentId={studentProfileId}`

**Authorization:** `PARENT` only

**Query Parameters:**
- `studentId` (required): UUID of child's student profile
- `academicYearId` (optional): Filter by academic year
- `sectionSubjectId` (optional): Filter by section-subject

**Response: `200 OK`**
```json
[
  {
    "id": "exam-uuid-123",
    "title": "Mid Term - Mathematics",
    "description": "Chapters 1-5",
    "heldAt": "2026-02-10T09:00:00.000Z",
    "maxScore": 100,
    "status": "PUBLISHED",
    "sectionSubject": {
      "section": {
        "name": "Section 1",
        "classGrade": {
          "name": "CLASS 5"
        }
      },
      "subject": {
        "name": "Mathematics"
      }
    },
    "academicYear": {
      "name": "YEAR 2026"
    },
    "createdByTeacher": {
      "fullName": "opf-teacher-1"
    }
  }
]
```

**Business Rules:**
- `studentId` is required (must be parent's child)
- Only shows PUBLISHED or CLOSED exams
- Only shows exams for sections child is enrolled in

**Errors:**
- `400 Bad Request`: studentId is required
- `403 Forbidden`: studentId is not parent's child

---

### 2. Get Exam (Parent)

**Endpoint:** `GET /api/exams/:id?studentId={studentProfileId}`

**Authorization:** `PARENT` only

**Query Parameters:**
- `studentId` (required): UUID of child's student profile

**Response: `200 OK`**
```json
{
  "id": "exam-uuid-123",
  "title": "Mid Term - Mathematics",
  "description": "Chapters 1-5",
  "heldAt": "2026-02-10T09:00:00.000Z",
  "maxScore": 100,
  "status": "PUBLISHED",
  "sectionSubject": {
    "section": {
      "name": "Section 1",
      "classGrade": {
        "name": "CLASS 5"
      }
    },
    "subject": {
      "name": "Mathematics"
    }
  },
  "academicYear": {
    "name": "YEAR 2026"
  },
  "createdByTeacher": {
    "fullName": "opf-teacher-1"
  }
}
```

**Business Rules:**
- `studentId` is required (must be parent's child)
- Only PUBLISHED or CLOSED exams are accessible
- Child must be enrolled in the exam's section

---

### 3. View Exam Result (Parent)

**Endpoint:** `GET /api/exams/:id/results?studentId={studentProfileId}`

**Authorization:** `PARENT` only

**Query Parameters:**
- `studentId` (required): UUID of child's student profile

**Response: `200 OK`**
```json
{
  "examId": "exam-uuid-123",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "result": {
    "id": "result-uuid-456",
    "examId": "exam-uuid-123",
    "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "score": 78,
    "grade": "B+",
    "rank": 5,
    "remarks": "Good performance",
    "markedAt": "2026-02-11T10:00:00.000Z",
    "createdAt": "2026-02-11T10:00:00.000Z",
    "updatedAt": "2026-02-11T10:00:00.000Z"
  }
}
```

**If no result yet:**
```json
{
  "examId": "exam-uuid-123",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "result": null
}
```

**Business Rules:**
- `studentId` is required (must be parent's child)
- Parent can only view their child's result
- Exam must be PUBLISHED or CLOSED
- Returns `null` if result not marked yet

---

## Common Flows

### Flow 1: Teacher Creates and Publishes Exam

```javascript
// Step 1: Create exam
const createResponse = await fetch('http://localhost:3002/api/exams', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${teacherToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    academicYearId: 'ed8d614c-797d-4b61-a58c-bc9c1e080879',
    sectionSubjectId: '98c6bc9c-3438-4536-b56a-b6b10b74904a',
    title: 'Mid Term - Mathematics',
    description: 'Chapters 1-5',
    heldAt: '2026-02-10T09:00:00.000Z',
    maxScore: 100
  })
});

const exam = await createResponse.json();
console.log('Created exam:', exam.id);
console.log('Status:', exam.status); // "DRAFT"

// Step 2: Publish exam (optional - can also update status directly)
const publishResponse = await fetch(
  `http://localhost:3002/api/exams/${exam.id}/publish`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${teacherToken}`
    }
  }
);

const publishedExam = await publishResponse.json();
console.log('Status:', publishedExam.status); // "PUBLISHED"
```

---

### Flow 2: Teacher Marks Exam Results

```javascript
// Step 1: List exams
const examsResponse = await fetch('http://localhost:3002/api/exams', {
  headers: {
    'Authorization': `Bearer ${teacherToken}`
  }
});

const exams = await examsResponse.json();

// Step 2: Select an exam
const exam = exams[0];

// Step 3: List enrolled students (NEW!)
const studentsResponse = await fetch(
  `http://localhost:3002/api/exams/${exam.id}/students`,
  {
    headers: {
      'Authorization': `Bearer ${teacherToken}`
    }
  }
);

const enrollments = await studentsResponse.json();
console.log('Enrolled students:', enrollments);

// Step 4: List all results to see who's been marked (NEW!)
const resultsResponse = await fetch(
  `http://localhost:3002/api/exams/${exam.id}/results`,
  {
    headers: {
      'Authorization': `Bearer ${teacherToken}`
    }
  }
);

const allResults = await resultsResponse.json();
console.log('All results:', allResults);

// Step 5: Mark result for a student
const markResponse = await fetch(
  `http://localhost:3002/api/exams/${exam.id}/results`,
  {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${teacherToken}`,
      'Content-Type': 'application/json'
    },
      body: JSON.stringify({
        studentId: '00ed8713-fc82-4819-8b45-1031933aabe0',
        score: 78,
        grade: 'B+',
        rank: 5,
        remarks: 'Good performance'
      })
  }
);

const result = await markResponse.json();
console.log('Marked result:', result);
```

---

### Flow 3: Student Views Exam Schedule and Results

```javascript
// Step 1: List exams (shows schedule)
const examsResponse = await fetch('http://localhost:3002/api/exams', {
  headers: {
    'Authorization': `Bearer ${studentToken}`
  }
});

const exams = await examsResponse.json();
console.log('Upcoming exams:', exams);

// Step 2: View specific exam details
const examResponse = await fetch(
  `http://localhost:3002/api/exams/${exams[0].id}`,
  {
    headers: {
      'Authorization': `Bearer ${studentToken}`
    }
  }
);

const exam = await examResponse.json();
console.log('Exam details:', exam);
console.log('Exam date:', exam.heldAt);

// Step 3: Check result (if marked)
const resultResponse = await fetch(
  `http://localhost:3002/api/exams/${exam.id}/results`,
  {
    headers: {
      'Authorization': `Bearer ${studentToken}`
    }
  }
);

const result = await resultResponse.json();
if (result.result) {
  console.log('Score:', result.result.score);
  console.log('Grade:', result.result.grade);
  console.log('Rank:', result.result.rank);
  console.log('Remarks:', result.result.remarks);
} else {
  console.log('Result not marked yet');
}
```

---

### Flow 4: Parent Views Child's Exams and Results

```javascript
const childStudentId = '00ed8713-fc82-4819-8b45-1031933aabe0';

// Step 1: List child's exams
const examsResponse = await fetch(
  `http://localhost:3002/api/exams?studentId=${childStudentId}`,
  {
    headers: {
      'Authorization': `Bearer ${parentToken}`
    }
  }
);

const exams = await examsResponse.json();
console.log('Child\'s exams:', exams);

// Step 2: View child's result for specific exam
const resultResponse = await fetch(
  `http://localhost:3002/api/exams/${exams[0].id}/results?studentId=${childStudentId}`,
  {
    headers: {
      'Authorization': `Bearer ${parentToken}`
    }
  }
);

const result = await resultResponse.json();
if (result.result) {
  console.log('Child\'s score:', result.result.score);
  console.log('Grade:', result.result.grade);
  console.log('Rank:', result.result.rank);
  console.log('Remarks:', result.result.remarks);
} else {
  console.log('Result not marked yet');
}
```

---

## Error Handling

### Common Error Responses

#### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": "Invalid academicYearId"
}
```

```json
{
  "statusCode": 400,
  "message": "studentId is required"
}
```

```json
{
  "statusCode": 400,
  "message": "score cannot exceed maxScore"
}
```

#### 403 Forbidden
```json
{
  "statusCode": 403,
  "message": "Only creator teacher can update"
}
```

```json
{
  "statusCode": 403,
  "message": "Exam is not published"
}
```

```json
{
  "statusCode": 403,
  "message": "Student not enrolled for this exam"
}
```

#### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "Exam not found"
}
```

---

## Complete API Reference Table

| Endpoint | Method | Role | Purpose | studentId Required? |
|----------|--------|------|---------|-------------------|
| `/api/exams` | POST | TEACHER | Create exam | No |
| `/api/exams` | GET | ALL | List exams | PARENT: Yes, Others: No |
| `/api/exams/:id` | GET | ALL | Get exam | PARENT: Yes, Others: No |
| `/api/exams/:id` | PATCH | TEACHER | Update exam | No |
| `/api/exams/:id/publish` | POST | TEACHER | Publish exam | No |
| `/api/exams/:id/close` | POST | TEACHER | Close exam | No |
| `/api/exams/:id/results` | PATCH | TEACHER | Mark result | Yes (in body) |
| `/api/exams/:id/results` | GET | TEACHER | List all results | No (lists all) |
| `/api/exams/:id/results` | GET | TEACHER | View specific result | Yes (query param) |
| `/api/exams/:id/results` | GET | STUDENT/PARENT | View result | PARENT: Yes, STUDENT: No |
| `/api/exams/:id/students` | GET | TEACHER | List enrolled students | No |

---

## Frontend Implementation Examples

### React Component: Exam List (Student)

```jsx
function ExamList() {
  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/exams', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
      .then(r => r.json())
      .then(data => {
        setExams(data);
        setLoading(false);
      });
  }, []);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h2>Upcoming Exams</h2>
      {exams.map(exam => (
        <div key={exam.id} className="exam-card">
          <h3>{exam.title}</h3>
          <p>{exam.description}</p>
          <p>Subject: {exam.sectionSubject.subject.name}</p>
          <p>Date: {new Date(exam.heldAt).toLocaleString()}</p>
          <p>Max Score: {exam.maxScore}</p>
          <Link to={`/exams/${exam.id}`}>View Details</Link>
        </div>
      ))}
    </div>
  );
}
```

### React Component: List All Results (Teacher)

```jsx
function ExamResultsList({ examId }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/exams/${examId}/results`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
      .then(r => r.json())
      .then(data => {
        setResults(data);
        setLoading(false);
      });
  }, [examId]);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h3>Exam Results</h3>
      <table>
        <thead>
          <tr>
            <th>Student</th>
            <th>Roll Number</th>
            <th>Score</th>
            <th>Grade</th>
            <th>Rank</th>
            <th>Remarks</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {results.map((item) => (
            <tr key={item.student.id}>
              <td>{item.student.fullName}</td>
              <td>{item.student.rollNumber}</td>
              <td>{item.result?.score ?? '-'}</td>
              <td>{item.result?.grade ?? '-'}</td>
              <td>{item.result?.rank ?? '-'}</td>
              <td>{item.result?.remarks ?? '-'}</td>
              <td>{item.result ? 'Marked' : 'Not Marked'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### React Component: List Enrolled Students (Teacher)

```jsx
function ExamStudentsList({ examId }) {
  const [students, setStudents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/exams/${examId}/students`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
      .then(r => r.json())
      .then(data => {
        setStudents(data);
        setLoading(false);
      });
  }, [examId]);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h3>Enrolled Students</h3>
      <ul>
        {students.map((enrollment) => (
          <li key={enrollment.id}>
            {enrollment.student.fullName} ({enrollment.student.rollNumber})
            - {enrollment.section.name} - {enrollment.section.classGrade.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### React Component: Mark Exam Result (Teacher)

```jsx
function MarkExamResult({ examId, studentId }) {
  const [score, setScore] = useState('');
  const [grade, setGrade] = useState('');
  const [rank, setRank] = useState('');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);

  const handleMark = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await fetch(`/api/exams/${examId}/results`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          studentId,
          score: score ? parseInt(score) : undefined,
          grade: grade || undefined,
          rank: rank ? parseInt(rank) : undefined,
          remarks: remarks || undefined
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message);
      }

      const result = await response.json();
      alert('Result marked successfully!');
    } catch (error) {
      alert(`Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleMark}>
      <div>
        <label>
          Score:
          <input
            type="number"
            min="0"
            max={exam.maxScore || undefined}
            value={score}
            onChange={(e) => setScore(e.target.value)}
          />
        </label>
      </div>

      <div>
        <label>
          Grade:
          <input
            type="text"
            placeholder="e.g., A+, B, C-"
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
          />
        </label>
      </div>

      <div>
        <label>
          Rank:
          <input
            type="number"
            min="1"
            value={rank}
            onChange={(e) => setRank(e.target.value)}
          />
        </label>
      </div>

      <div>
        <label>
          Remarks:
          <textarea
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            rows={4}
          />
        </label>
      </div>

      <button type="submit" disabled={loading}>
        {loading ? 'Marking...' : 'Mark Result'}
      </button>
    </form>
  );
}
```

### React Component: View Exam Result (Student)

```jsx
function ExamResult({ examId }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/exams/${examId}/results`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
      .then(r => r.json())
      .then(data => {
        setResult(data);
        setLoading(false);
      });
  }, [examId]);

  if (loading) return <div>Loading...</div>;

  if (!result.result) {
    return <div>Result not marked yet</div>;
  }

  return (
    <div>
      <h3>Exam Result</h3>
      <p>Score: {result.result.score} / {exam.maxScore}</p>
      {result.result.grade && <p>Grade: {result.result.grade}</p>}
      {result.result.rank && <p>Rank: {result.result.rank}</p>}
      <p>Remarks: {result.result.remarks}</p>
      <p>Marked At: {new Date(result.result.markedAt).toLocaleString()}</p>
    </div>
  );
}
```

---

## Summary

### Key Points

1. **Exams don't have file submissions** - Teachers mark results directly
2. **Status flow**: DRAFT → PUBLISHED → CLOSED
3. **Results are marked per student** - Each student has their own result record
4. **studentId parameter**: Required for PARENT and TEACHER when viewing results
5. **Access control**: Students/Parents can only see PUBLISHED/CLOSED exams

### Teacher Workflow
1. Create exam (DRAFT)
2. Publish exam (PUBLISHED)
3. Mark results for students
4. Close exam (CLOSED)

### Student Workflow
1. View exam schedule (PUBLISHED/CLOSED exams)
2. View exam details
3. View result (if marked)

### Parent Workflow
1. View child's exam schedule (with studentId)
2. View child's exam details (with studentId)
3. View child's result (with studentId)

---

## Quick Reference

### Base URL
```
http://localhost:3002/api/exams
```

### Authentication
All endpoints require:
```
Authorization: Bearer <token>
```

### Content-Type
- JSON endpoints: `application/json`
- No file uploads in exam module

---

## Notes for Frontend Team

1. **No file uploads**: Unlike assignments, exams don't have student submissions
2. **Results are optional**: Students may not have results until teacher marks them
3. **studentId parameter**: Always required for PARENT, required for TEACHER when viewing results
4. **Status filtering**: Students/Parents only see PUBLISHED/CLOSED exams
5. **Re-marking allowed**: Teachers can update results multiple times
6. **Upsert behavior**: Marking result creates or updates existing result

