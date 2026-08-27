# Mark Submission - Critical Analysis

## Current Implementation

### Endpoint
```
PATCH /api/assignments/submissions/:submissionId/mark
```

### Current Flow
1. ✅ Validates teacher role
2. ✅ Finds submission with assignment
3. ✅ Validates teacher is creator of assignment
4. ✅ Validates score doesn't exceed maxScore
5. ✅ Updates submission with score, remarks, status='MARKED', markedAt
6. ❌ **Returns minimal response** (only updated fields)

---

## Critical Issues Found

### 🔴 Issue 1: No Status Validation
**Problem:** Can mark submissions that are still `UPLOADING` (not yet submitted)

**Current Code:**
```typescript
// No check for submission.status === 'SUBMITTED'
return (this.prisma as any).assignmentSubmission.update({
  where: { id: submissionId },
  data: {
    status: 'MARKED', // Can mark UPLOADING submissions!
  },
});
```

**Impact:** Teachers can mark incomplete submissions

**Fix Needed:**
```typescript
if (submission.status !== 'SUBMITTED') {
  throw new BadRequestException('Can only mark SUBMITTED submissions');
}
```

---

### 🔴 Issue 2: No Assignment Status Check
**Problem:** Can mark submissions for `DRAFT` assignments

**Current Code:**
```typescript
// No check for assignment.status
const teacher = await this.getTeacherOrThrow(actor, submission.assignment.schoolId);
if (submission.assignment.createdByTeacherId !== teacher.id) {
  throw new ForbiddenException('Only creator teacher can mark');
}
// Proceeds to mark even if assignment.status === 'DRAFT'
```

**Impact:** Teachers can mark submissions before assignment is published

**Fix Needed:**
```typescript
if (!['PUBLISHED', 'CLOSED'].includes(submission.assignment.status)) {
  throw new BadRequestException('Can only mark submissions for PUBLISHED or CLOSED assignments');
}
```

---

### 🟡 Issue 3: Can Re-mark Multiple Times
**Problem:** No check if already marked - allows re-grading

**Current Behavior:** Can mark the same submission multiple times

**Impact:** 
- ✅ **Good:** Allows re-grading/corrections
- ⚠️ **Bad:** No audit trail of previous marks
- ⚠️ **Bad:** Can overwrite marks without warning

**Consideration:** This might be intentional for re-grading, but should log previous marks

---

### 🟡 Issue 4: Incomplete Response
**Problem:** Returns only updated fields, not full submission data

**Current Response:**
```json
{
  "id": "...",
  "status": "MARKED",
  "score": 9,
  "remarks": "Good work",
  "markedAt": "2026-01-25T10:00:00.000Z"
}
```

**Missing:**
- Student information
- Assignment information
- File information (fileName, downloadUrl)
- Submission metadata

**Impact:** Frontend needs to make another API call to get full data

**Fix Needed:** Include full submission with relations

---

### 🟡 Issue 5: No Score Validation
**Problem:** Can mark without providing score (only remarks)

**Current Code:**
```typescript
data: {
  ...(dto.score !== undefined && { score: dto.score }),
  ...(dto.remarks !== undefined && { remarks: dto.remarks ?? null }),
  status: 'MARKED',
}
```

**Impact:** 
- Can mark with only remarks (score = null)
- Can mark with only score (remarks = null)
- Can mark with neither (both null) - **This is problematic!**

**Fix Needed:** Require at least score OR remarks

---

### 🟡 Issue 6: listSubmissions Shows All Statuses
**Problem:** `listSubmissions` shows `UPLOADING` submissions

**Current Code:**
```typescript
return (this.prisma as any).assignmentSubmission.findMany({
  where: { assignmentId }, // No status filter
  include: { student: true },
});
```

**Impact:** Teachers see incomplete submissions in the list

**Consideration:** Might be intentional to see who started but didn't finish

---

## Recommended Fixes

### Fix 1: Add Status Validation
```typescript
async markSubmission(submissionId: string, dto: MarkSubmissionDto, actor: Actor) {
  this.ensureRole(actor, [Role.TEACHER]);

  const submission = await (this.prisma as any).assignmentSubmission.findUnique({
    where: { id: submissionId },
    include: { assignment: true },
  });
  if (!submission) throw new NotFoundException('Submission not found');

  // ✅ NEW: Check submission status
  if (submission.status !== 'SUBMITTED') {
    throw new BadRequestException('Can only mark SUBMITTED submissions. Current status: ' + submission.status);
  }

  // ✅ NEW: Check assignment status
  if (!['PUBLISHED', 'CLOSED'].includes(submission.assignment.status)) {
    throw new BadRequestException('Can only mark submissions for PUBLISHED or CLOSED assignments');
  }

  const teacher = await this.getTeacherOrThrow(actor, submission.assignment.schoolId);
  if (submission.assignment.createdByTeacherId !== teacher.id) {
    throw new ForbiddenException('Only creator teacher can mark');
  }

  // ✅ NEW: Require at least score or remarks
  if (dto.score === undefined && !dto.remarks) {
    throw new BadRequestException('Either score or remarks must be provided');
  }

  const maxScore = submission.assignment.maxScore as number | null;
  if (dto.score !== undefined && maxScore !== null && dto.score > maxScore) {
    throw new BadRequestException('score cannot exceed maxScore');
  }

  // ✅ NEW: Return full submission data
  return (this.prisma as any).assignmentSubmission.update({
    where: { id: submissionId },
    data: {
      ...(dto.score !== undefined && { score: dto.score }),
      ...(dto.remarks !== undefined && { remarks: dto.remarks ?? null }),
      status: 'MARKED',
      markedAt: new Date(),
    },
    include: {
      assignment: {
        include: {
          sectionSubject: {
            include: {
              section: { include: { classGrade: true } },
              subject: true,
            },
          },
          academicYear: true,
        },
      },
      student: true,
    },
  });
}
```

### Fix 2: Enhance listSubmissions (Optional)
```typescript
async listSubmissions(assignmentId: string, actor: Actor, query?: { status?: string }) {
  // ... existing code ...
  
  const where: any = { assignmentId };
  
  // ✅ NEW: Filter by status if provided
  if (query?.status) {
    where.status = query.status;
  }
  
  return (this.prisma as any).assignmentSubmission.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      student: true,
    },
  });
}
```

---

## Complete Fixed Implementation

```typescript
async markSubmission(submissionId: string, dto: MarkSubmissionDto, actor: Actor) {
  this.ensureRole(actor, [Role.TEACHER]);

  const submission = await (this.prisma as any).assignmentSubmission.findUnique({
    where: { id: submissionId },
    include: {
      assignment: {
        include: {
          sectionSubject: {
            include: {
              section: { include: { classGrade: true } },
              subject: true,
            },
          },
          academicYear: true,
        },
      },
      student: true,
    },
  });
  
  if (!submission) throw new NotFoundException('Submission not found');

  // ✅ Validate submission status
  if (submission.status !== 'SUBMITTED') {
    throw new BadRequestException(
      `Cannot mark submission with status '${submission.status}'. Only SUBMITTED submissions can be marked.`
    );
  }

  // ✅ Validate assignment status
  if (!['PUBLISHED', 'CLOSED'].includes(submission.assignment.status)) {
    throw new BadRequestException(
      `Cannot mark submissions for assignment with status '${submission.assignment.status}'. ` +
      `Only PUBLISHED or CLOSED assignments can have submissions marked.`
    );
  }

  const teacher = await this.getTeacherOrThrow(actor, submission.assignment.schoolId);
  if (submission.assignment.createdByTeacherId !== teacher.id) {
    throw new ForbiddenException('Only creator teacher can mark');
  }

  // ✅ Require at least score or remarks
  if (dto.score === undefined && (!dto.remarks || dto.remarks.trim() === '')) {
    throw new BadRequestException('Either score or remarks must be provided');
  }

  const maxScore = submission.assignment.maxScore as number | null;
  if (dto.score !== undefined) {
    if (maxScore !== null && dto.score > maxScore) {
      throw new BadRequestException(`Score (${dto.score}) cannot exceed maxScore (${maxScore})`);
    }
    if (dto.score < 0) {
      throw new BadRequestException('Score cannot be negative');
    }
  }

  const updated = await (this.prisma as any).assignmentSubmission.update({
    where: { id: submissionId },
    data: {
      ...(dto.score !== undefined && { score: dto.score }),
      ...(dto.remarks !== undefined && { remarks: dto.remarks ?? null }),
      status: 'MARKED',
      markedAt: new Date(),
    },
    include: {
      assignment: {
        include: {
          sectionSubject: {
            include: {
              section: { include: { classGrade: true } },
              subject: true,
            },
          },
          academicYear: true,
          createdByTeacher: true,
        },
      },
      student: true,
    },
  });

  // ✅ Generate download URL for submission file
  let downloadUrl: string | null = null;
  if (updated.s3Key) {
    try {
      const { url } = await this.s3.presignGetObject({ key: updated.s3Key });
      downloadUrl = url;
    } catch (error) {
      console.error(`Failed to generate download URL for submission ${updated.id}:`, error);
    }
  }

  return { ...updated, downloadUrl };
}
```

---

## API Usage Examples

### Mark Submission (Fixed)
```http
PATCH /api/assignments/submissions/:submissionId/mark
Authorization: Bearer <token>
Content-Type: application/json

{
  "score": 9,
  "remarks": "Good work, but missed question 3"
}
```

### Response (Fixed)
```json
{
  "id": "433a65e5-ce4c-46dc-9eeb-403aa532d7a2",
  "assignmentId": "1593ea68-3f8a-4229-b59d-840599e06a91",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "status": "MARKED",
  "score": 9,
  "remarks": "Good work, but missed question 3",
  "markedAt": "2026-01-25T10:00:00.000Z",
  "submittedAt": "2026-01-20T14:30:00.000Z",
  "fileName": "homework.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 123456,
  "s3Key": "...",
  "downloadUrl": "https://s3.../homework.pdf?X-Amz-Signature=...",
  "assignment": {
    "id": "1593ea68-3f8a-4229-b59d-840599e06a91",
    "title": "Math Homework 1",
    "maxScore": 10,
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
    }
  },
  "student": {
    "id": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "fullName": "John Doe",
    "rollNumber": "ST001"
  }
}
```

---

## Summary

### ✅ What Works
- Basic authorization (teacher only, creator only)
- Score validation (doesn't exceed maxScore)
- Updates status to MARKED
- Records markedAt timestamp

### 🔴 Critical Issues
1. **Can mark UPLOADING submissions** - Should only mark SUBMITTED
2. **Can mark DRAFT assignments** - Should only mark PUBLISHED/CLOSED
3. **Can mark without score or remarks** - Should require at least one
4. **Incomplete response** - Should return full submission data

### 🟡 Minor Issues
1. **No re-marking protection** - Can overwrite marks (might be intentional)
2. **listSubmissions shows all statuses** - Might want to filter

### ✅ Recommended Fixes
1. Add submission status check (`SUBMITTED` only)
2. Add assignment status check (`PUBLISHED` or `CLOSED` only)
3. Require at least score OR remarks
4. Return full submission with relations and downloadUrl
5. Add better error messages

