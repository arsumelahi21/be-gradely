# How Student Identification Works in Marking

## Short Answer

**No, marking one submission does NOT mark for all students.** Each student has their own separate submission record. When you mark a submission by `submissionId`, you're marking that specific student's submission only.

---

## How It Works

### Database Structure

Each `AssignmentSubmission` record is **uniquely linked to one student**:

```prisma
model AssignmentSubmission {
  id            String   @id @default(uuid())  // Unique submission ID
  assignmentId  String                         // Which assignment
  studentId     String                         // Which student ← KEY FIELD
  status        AssignmentSubmissionStatus
  score         Int?
  remarks       String?
  // ...
  
  @@unique([assignmentId, studentId])  // ← One submission per student per assignment
}
```

### Key Points

1. **Each student has their own submission record**
   - Student A submits → Creates `submissionId: "abc-123"` with `studentId: "student-A"`
   - Student B submits → Creates `submissionId: "def-456"` with `studentId: "student-B"`
   - Student C submits → Creates `submissionId: "ghi-789"` with `studentId: "student-C"`

2. **Unique constraint ensures one submission per student**
   - `@@unique([assignmentId, studentId])` means:
   - One assignment can have multiple submissions (one per student)
   - But each student can only have ONE submission per assignment

3. **Marking uses `submissionId` to identify the student**
   - When you mark `submissionId: "abc-123"`, the system:
     - Finds that submission record
     - Sees it belongs to `studentId: "student-A"`
     - Updates ONLY that student's submission
     - Other students' submissions remain unchanged

---

## Complete Flow Example

### Step 1: Students Submit

**Student A submits:**
```javascript
POST /api/assignments/assignment-123/submissions/request-upload
// Creates: submissionId: "sub-A", studentId: "student-A"
```

**Student B submits:**
```javascript
POST /api/assignments/assignment-123/submissions/request-upload
// Creates: submissionId: "sub-B", studentId: "student-B"
```

**Student C submits:**
```javascript
POST /api/assignments/assignment-123/submissions/request-upload
// Creates: submissionId: "sub-C", studentId: "student-C"
```

### Step 2: Teacher Lists All Submissions

```javascript
GET /api/assignments/assignment-123/submissions
```

**Response:**
```json
[
  {
    "id": "sub-A",
    "assignmentId": "assignment-123",
    "studentId": "student-A",  // ← Student A
    "status": "SUBMITTED",
    "student": {
      "id": "student-A",
      "fullName": "John Doe"
    }
  },
  {
    "id": "sub-B",
    "assignmentId": "assignment-123",
    "studentId": "student-B",  // ← Student B
    "status": "SUBMITTED",
    "student": {
      "id": "student-B",
      "fullName": "Jane Smith"
    }
  },
  {
    "id": "sub-C",
    "assignmentId": "assignment-123",
    "studentId": "student-C",  // ← Student C
    "status": "SUBMITTED",
    "student": {
      "id": "student-C",
      "fullName": "Bob Johnson"
    }
  }
]
```

### Step 3: Teacher Marks Student A's Submission

```javascript
PATCH /api/assignments/submissions/sub-A/mark
{
  "score": 9,
  "remarks": "Good work"
}
```

**What happens:**
1. System finds submission with `id: "sub-A"`
2. System sees `studentId: "student-A"` in that record
3. System updates ONLY that submission:
   - Sets `status: "MARKED"`
   - Sets `score: 9`
   - Sets `remarks: "Good work"`
   - Sets `markedAt: "2026-01-25T10:00:00.000Z"`
4. **Student B and Student C's submissions remain UNCHANGED**

### Step 4: Teacher Marks Student B's Submission

```javascript
PATCH /api/assignments/submissions/sub-B/mark
{
  "score": 7,
  "remarks": "Needs improvement"
}
```

**Result:**
- Student A: Still marked with score 9
- Student B: Now marked with score 7
- Student C: Still SUBMITTED (not marked)

---

## Visual Representation

```
Assignment: "Math Homework 1"
├── Submission 1 (sub-A)
│   ├── Student: John Doe (student-A)
│   ├── Status: MARKED ✅
│   ├── Score: 9
│   └── Remarks: "Good work"
│
├── Submission 2 (sub-B)
│   ├── Student: Jane Smith (student-B)
│   ├── Status: MARKED ✅
│   ├── Score: 7
│   └── Remarks: "Needs improvement"
│
└── Submission 3 (sub-C)
    ├── Student: Bob Johnson (student-C)
    ├── Status: SUBMITTED ⏳
    ├── Score: null
    └── Remarks: null
```

**Each submission is independent!**

---

## Code Verification

### When Submission is Created

```typescript
// In requestUpload method
const student = await this.getStudentOrThrow(actor); // ← Gets logged-in student

const submission = await this.prisma.assignmentSubmission.upsert({
  where: {
    assignmentId_studentId: {
      assignmentId: assignment.id,
      studentId: student.id,  // ← Linked to specific student
    },
  },
  create: {
    assignmentId: assignment.id,
    studentId: student.id,  // ← Each submission has studentId
    // ...
  },
});
```

### When Submission is Marked

```typescript
// In markSubmission method
const submission = await this.prisma.assignmentSubmission.findUnique({
  where: { id: submissionId },  // ← Finds specific submission
  include: {
    student: true,  // ← Includes student info
  },
});

// submission.studentId identifies which student
// submission.student contains student details

// Updates ONLY this specific submission
return this.prisma.assignmentSubmission.update({
  where: { id: submissionId },  // ← Updates only this submission
  data: {
    score: dto.score,
    remarks: dto.remarks,
    status: 'MARKED',
  },
});
```

---

## Database Query Example

### When You Mark Submission "sub-A"

```sql
-- Step 1: Find the submission
SELECT * FROM "AssignmentSubmission" 
WHERE id = 'sub-A';

-- Result:
-- id: 'sub-A'
-- assignmentId: 'assignment-123'
-- studentId: 'student-A'  ← This identifies the student
-- status: 'SUBMITTED'

-- Step 2: Update ONLY this submission
UPDATE "AssignmentSubmission"
SET 
  status = 'MARKED',
  score = 9,
  remarks = 'Good work',
  markedAt = NOW()
WHERE id = 'sub-A';  ← Only updates this one record

-- Other students' submissions are NOT affected!
```

---

## Frontend Flow

### Teacher's View

```javascript
// 1. List all submissions for an assignment
const submissions = await fetch(
  '/api/assignments/assignment-123/submissions'
).then(r => r.json());

// Response shows each student separately:
// [
//   { id: 'sub-A', student: { fullName: 'John Doe' }, status: 'SUBMITTED' },
//   { id: 'sub-B', student: { fullName: 'Jane Smith' }, status: 'SUBMITTED' },
//   { id: 'sub-C', student: { fullName: 'Bob Johnson' }, status: 'SUBMITTED' }
// ]

// 2. Teacher selects John Doe's submission and marks it
await fetch('/api/assignments/submissions/sub-A/mark', {
  method: 'PATCH',
  body: JSON.stringify({ score: 9, remarks: 'Good work' })
});

// 3. Only John Doe's submission is marked
// Jane and Bob's submissions remain SUBMITTED
```

### Student's View

```javascript
// Student A views their result
const result = await fetch(
  '/api/assignments/assignment-123/results'
).then(r => r.json());

// Response shows ONLY Student A's submission:
// {
//   assignmentId: 'assignment-123',
//   studentId: 'student-A',
//   submission: {
//     id: 'sub-A',
//     status: 'MARKED',
//     score: 9,
//     remarks: 'Good work'
//   }
// }

// Student B sees their own result (different submission)
// Student C sees their own result (different submission)
```

---

## Summary

### ✅ How It Works
1. **Each student creates their own submission** when they submit
2. **Each submission has a unique `submissionId`** and is linked to a specific `studentId`
3. **Marking uses `submissionId`** to find and update that specific submission
4. **Only that one student's submission is updated** - others remain unchanged

### ✅ Database Guarantees
- **Unique constraint:** `@@unique([assignmentId, studentId])` ensures one submission per student per assignment
- **Foreign key:** `studentId` links each submission to a specific student
- **Primary key:** `id` (submissionId) uniquely identifies each submission

### ✅ Answer to Your Question
**"If I mark an assignment for one student, would it be marked for all students?"**

**NO!** Each student has their own separate submission record. Marking one `submissionId` only affects that specific student's submission. Other students' submissions remain in their current state (SUBMITTED, UPLOADING, etc.).

---

## Example Scenario

**Assignment:** "Math Homework 1" (maxScore: 10)
**Students:** John, Jane, Bob

| Student | Submission ID | Status Before | Mark Action | Status After |
|---------|--------------|---------------|-------------|--------------|
| John    | sub-A        | SUBMITTED     | Mark (score: 9) | MARKED ✅ |
| Jane    | sub-B        | SUBMITTED     | (not marked) | SUBMITTED ⏳ |
| Bob     | sub-C        | SUBMITTED     | (not marked) | SUBMITTED ⏳ |

**Result:** Only John's submission is marked. Jane and Bob's submissions remain SUBMITTED until the teacher marks them individually.

