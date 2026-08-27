# Assignment API - Payloads and Responses

## 1. Create Assignment (Teacher) - Direct Upload

### Endpoint
```
POST /api/assignments
```

### Authorization
- Role: `TEACHER`
- Header: `Authorization: Bearer <token>`

### Request
**Content-Type:** `multipart/form-data`

**Form Fields:**
```
academicYearId: string (UUID, required)
sectionSubjectId: string (UUID, required)
title: string (required)
description: string (optional)
dueAt: string (ISO date string, optional)
maxScore: number (integer ≥ 0, optional)
attachments: File[] (optional, max 10 files, 25MB each)
```

### Example Request (JavaScript)
```javascript
const formData = new FormData();
formData.append('academicYearId', 'ed8d614c-797d-4b61-a58c-bc9c1e080879');
formData.append('sectionSubjectId', '98c6bc9c-3438-4536-b56a-b6b10b74904a');
formData.append('title', 'Math Homework 1');
formData.append('description', 'Complete exercises 1-10');
formData.append('dueAt', '2026-01-31T23:59:59.000Z');
formData.append('maxScore', '10');
formData.append('attachments', file1); // File object
formData.append('attachments', file2); // Optional: multiple files

const response = await fetch('http://localhost:3002/api/assignments', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
    // Don't set Content-Type - browser will set it with boundary
  },
  body: formData
});
```

### Example Request (cURL)
```bash
curl -X POST http://localhost:3002/api/assignments \
  -H "Authorization: Bearer <token>" \
  -F "academicYearId=ed8d614c-797d-4b61-a58c-bc9c1e080879" \
  -F "sectionSubjectId=98c6bc9c-3438-4536-b56a-b6b10b74904a" \
  -F "title=Math Homework 1" \
  -F "description=Complete exercises 1-10" \
  -F "dueAt=2026-01-31T23:59:59.000Z" \
  -F "maxScore=10" \
  -F "attachments=@/path/to/file1.pdf" \
  -F "attachments=@/path/to/file2.png"
```

### Response: `201 Created`
```json
{
  "id": "6536540e-210d-41ed-8967-c3aefd4f4f3f",
  "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
  "academicYearId": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
  "sectionSubjectId": "98c6bc9c-3438-4536-b56a-b6b10b74904a",
  "createdByTeacherId": "408bd87e-06fe-4050-86d0-b72108a23044",
  "title": "Math Homework 1",
  "description": "Complete exercises 1-10",
  "dueAt": "2026-01-31T23:59:59.000Z",
  "maxScore": 10,
  "status": "DRAFT",
  "createdAt": "2026-01-21T08:20:29.422Z",
  "updatedAt": "2026-01-21T08:20:29.422Z",
  "sectionSubject": {
    "id": "98c6bc9c-3438-4536-b56a-b6b10b74904a",
    "sectionId": "afe23989-ac39-4562-8193-d8e272c65a86",
    "subjectId": "2e22af00-cd81-4ee0-bed5-a21c11fab53b",
    "teacherId": "408bd87e-06fe-4050-86d0-b72108a23044",
    "schedule": null,
    "isPrimary": false,
    "createdAt": "2026-01-07T15:18:44.864Z",
    "updatedAt": "2026-01-07T15:19:06.147Z",
    "section": {
      "id": "afe23989-ac39-4562-8193-d8e272c65a86",
      "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
      "classGradeId": "765fe825-b20b-4ac7-8f48-40fb9f84a4ac",
      "name": "Section 1",
      "room": "room 123",
      "isActive": true,
      "createdAt": "2026-01-07T15:18:12.175Z",
      "updatedAt": "2026-01-07T15:18:12.175Z",
      "classGrade": {
        "id": "765fe825-b20b-4ac7-8f48-40fb9f84a4ac",
        "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
        "name": "CLASS 5",
        "code": "CLASS-5",
        "description": "this is class 5th descripiton",
        "isActive": true,
        "createdAt": "2026-01-07T15:17:49.430Z",
        "updatedAt": "2026-01-07T15:17:49.430Z"
      }
    },
    "subject": {
      "id": "2e22af00-cd81-4ee0-bed5-a21c11fab53b",
      "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
      "name": "Chinese",
      "code": "CHINESE-CODE-1",
      "description": null,
      "isCore": true,
      "createdAt": "2025-12-31T15:23:32.887Z",
      "updatedAt": "2025-12-31T15:23:32.887Z"
    },
    "teacher": {
      "id": "408bd87e-06fe-4050-86d0-b72108a23044",
      "userId": "421711b1-1feb-46c1-aba5-551a04885924",
      "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
      "fullName": "opf-teacher-1",
      "phone": "+92323232323",
      "isActive": true,
      "createdAt": "2025-12-31T11:21:03.095Z",
      "updatedAt": "2025-12-31T11:21:03.095Z"
    }
  },
  "academicYear": {
    "id": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
    "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
    "name": "YEAR 2026",
    "code": "2026-2027",
    "startDate": "2026-01-01T00:00:00.000Z",
    "endDate": "2027-01-07T00:00:00.000Z",
    "isActive": true,
    "createdAt": "2026-01-07T10:30:18.675Z",
    "updatedAt": "2026-01-07T10:30:18.675Z"
  },
  "createdByTeacher": {
    "id": "408bd87e-06fe-4050-86d0-b72108a23044",
    "userId": "421711b1-1feb-46c1-aba5-551a04885924",
    "schoolId": "949654eb-69d7-417b-a993-f4ee54aad4b9",
    "fullName": "opf-teacher-1",
    "phone": "+92323232323",
    "isActive": true,
    "createdAt": "2025-12-31T11:21:03.095Z",
    "updatedAt": "2025-12-31T11:21:03.095Z"
  },
  "attachments": [
    {
      "id": "f971ce60-d849-4258-86de-ad27cfa434d5",
      "assignmentId": "6536540e-210d-41ed-8967-c3aefd4f4f3f",
      "uploadedByTeacherId": "408bd87e-06fe-4050-86d0-b72108a23044",
      "status": "READY",
      "s3Key": "gradely/school/949654eb-69d7-417b-a993-f4ee54aad4b9/academic-year/ed8d614c-797d-4b61-a58c-bc9c1e080879/section-subject/98c6bc9c-3438-4536-b56a-b6b10b74904a/assignment/6536540e-210d-41ed-8967-c3aefd4f4f3f/attachments/d3f53514-e1f2-4b28-ba3f-d4653004bfda-logo-1.png",
      "fileName": "logo-1.png",
      "mimeType": "image/png",
      "sizeBytes": 988111,
      "createdAt": "2026-01-21T08:20:55.693Z",
      "updatedAt": "2026-01-21T08:20:55.693Z",
      "downloadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/gradely/school/949654eb-69d7-417b-a993-f4ee54aad4b9/academic-year/ed8d614c-797d-4b61-a58c-bc9c1e080879/section-subject/98c6bc9c-3438-4536-b56a-b6b10b74904a/assignment/6536540e-210d-41ed-8967-c3aefd4f4f3f/attachments/d3f53514-e1f2-4b28-ba3f-d4653004bfda-logo-1.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=..."
    }
  ]
}
```

### Response Fields
- ✅ **attachments[].downloadUrl**: Presigned download URL (expires in 15 minutes)
- ✅ **attachments[].s3Key**: S3 storage key
- ✅ **attachments[].fileName**: Original file name
- ✅ **attachments[].mimeType**: File MIME type
- ✅ **attachments[].sizeBytes**: File size in bytes

---

## 2. Submit Assignment (Student) - Direct Upload

### Step 1: Request Upload URL (Get Submission ID)

#### Endpoint
```
POST /api/assignments/:assignmentId/submissions/request-upload
```

#### Authorization
- Role: `STUDENT`
- Header: `Authorization: Bearer <token>`

#### Request Body
```json
{
  "fileName": "homework.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 123456
}
```

**Note:** All fields are optional. This endpoint creates/updates a submission record and returns a `submissionId`.

#### Response: `201 Created`
```json
{
  "submissionId": "433a65e5-ce4c-46dc-9eeb-403aa532d7a2",
  "s3Key": "gradely/school/.../assignment/.../student/.../uuid-homework.pdf",
  "uploadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/...?X-Amz-Signature=..."
}
```

**Note:** You can skip Step 1 if you're using direct upload (Step 2). However, you still need a `submissionId`. You can either:
- Call `request-upload` first to get `submissionId`, OR
- Use an existing `submissionId` from a previous attempt

---

### Step 2: Submit Assignment with File

#### Endpoint
```
POST /api/assignments/:assignmentId/submissions/:submissionId/submit
```

#### Authorization
- Role: `STUDENT`
- Header: `Authorization: Bearer <token>`

#### Request
**Content-Type:** `multipart/form-data`

**Form Fields:**
```
files: File[] (optional, max 10 files, 25MB each)
```

**Note:** If you provide files, they will be uploaded directly. If you don't provide files, it will use the existing `s3Key` from the submission record (if you used presigned URL flow).

#### Example Request (JavaScript)
```javascript
// Step 1: Get submission ID (optional if you already have one)
const uploadResponse = await fetch(
  `http://localhost:3002/api/assignments/${assignmentId}/submissions/request-upload`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size
    })
  }
);
const { submissionId } = await uploadResponse.json();

// Step 2: Submit with file
const formData = new FormData();
formData.append('files', file); // File object

const submitResponse = await fetch(
  `http://localhost:3002/api/assignments/${assignmentId}/submissions/${submissionId}/submit`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
      // Don't set Content-Type - browser will set it with boundary
    },
    body: formData
  }
);
```

#### Example Request (cURL)
```bash
# Step 1: Get submission ID
curl -X POST http://localhost:3002/api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/submissions/request-upload \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "homework.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 123456
  }'

# Step 2: Submit with file
curl -X POST http://localhost:3002/api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/submissions/433a65e5-ce4c-46dc-9eeb-403aa532d7a2/submit \
  -H "Authorization: Bearer <token>" \
  -F "files=@/path/to/homework.pdf"
```

#### Response: `200 OK`
```json
{
  "id": "433a65e5-ce4c-46dc-9eeb-403aa532d7a2",
  "assignmentId": "1593ea68-3f8a-4229-b59d-840599e06a91",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "status": "SUBMITTED",
  "submittedAt": "2026-01-21T08:30:00.000Z",
  "s3Key": "gradely/school/949654eb-69d7-417b-a993-f4ee54aad4b9/academic-year/ed8d614c-797d-4b61-a58c-bc9c1e080879/section-subject/98c6bc9c-3438-4536-b56a-b6b10b74904a/assignment/1593ea68-3f8a-4229-b59d-840599e06a91/student/00ed8713-fc82-4819-8b45-1031933aabe0/uuid-homework.pdf",
  "fileName": "homework.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 123456,
  "score": null,
  "remarks": null,
  "markedAt": null,
  "createdAt": "2026-01-21T08:20:00.000Z",
  "updatedAt": "2026-01-21T08:30:00.000Z",
  "downloadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/gradely/school/949654eb-69d7-417b-a993-f4ee54aad4b9/academic-year/ed8d614c-797d-4b61-a58c-bc9c1e080879/section-subject/98c6bc9c-3438-4536-b56a-b6b10b74904a/assignment/1593ea68-3f8a-4229-b59d-840599e06a91/student/00ed8713-fc82-4819-8b45-1031933aabe0/uuid-homework.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=...",
  "assignment": {
    "id": "1593ea68-3f8a-4229-b59d-840599e06a91",
    "title": "Math Homework 1",
    "description": "Complete exercises 1-10",
    "dueAt": "2026-01-31T23:59:59.000Z",
    "maxScore": 10,
    "status": "PUBLISHED",
    "sectionSubject": {
      "section": {
        "name": "Section 1",
        "classGrade": {
          "name": "CLASS 5",
          "code": "CLASS-5"
        }
      },
      "subject": {
        "name": "Chinese",
        "code": "CHINESE-CODE-1"
      }
    },
    "academicYear": {
      "name": "YEAR 2026",
      "code": "2026-2027"
    },
    "createdByTeacher": {
      "fullName": "opf-teacher-1"
    }
  },
  "student": {
    "id": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "fullName": "OPF-STUDENT-1",
    "email": "student@example.com"
  }
}
```

### Response Fields
- ✅ **downloadUrl**: Presigned download URL for the submitted file (expires in 15 minutes)
- ✅ **s3Key**: S3 storage key
- ✅ **fileName**: Original file name
- ✅ **mimeType**: File MIME type
- ✅ **sizeBytes**: File size in bytes
- ✅ **status**: `"SUBMITTED"`
- ✅ **submittedAt**: Timestamp when submitted

---

## Complete Flow Example (Student Submission)

```javascript
async function submitAssignment(assignmentId, file, token) {
  // Step 1: Get submission ID
  const uploadResponse = await fetch(
    `http://localhost:3002/api/assignments/${assignmentId}/submissions/request-upload`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size
      })
    }
  );
  
  if (!uploadResponse.ok) {
    throw new Error('Failed to request upload');
  }
  
  const { submissionId } = await uploadResponse.json();
  
  // Step 2: Submit with file
  const formData = new FormData();
  formData.append('files', file);
  
  const submitResponse = await fetch(
    `http://localhost:3002/api/assignments/${assignmentId}/submissions/${submissionId}/submit`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData
    }
  );
  
  if (!submitResponse.ok) {
    throw new Error('Failed to submit assignment');
  }
  
  const submission = await submitResponse.json();
  
  // Use downloadUrl to display/download the file
  console.log('Download URL:', submission.downloadUrl);
  console.log('File:', submission.fileName);
  console.log('Size:', submission.sizeBytes);
  
  return submission;
}
```

---

## Important Notes

1. **Download URLs expire in 15 minutes** (configurable via `AWS_S3_PRESIGN_EXPIRES_IN_SECONDS`)
2. **File size limit**: 25MB per file, max 10 files
3. **Assignment status**: Students can only submit to `PUBLISHED` or `CLOSED` assignments
4. **One submission per student**: Each student can have only one submission per assignment
5. **Direct upload**: Files are uploaded directly to S3, not through your backend server

---

## Error Responses

### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": "Invalid academicYearId"
}
```

### 403 Forbidden
```json
{
  "statusCode": 403,
  "message": "Assignment is not published"
}
```

### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "Assignment not found"
}
```

