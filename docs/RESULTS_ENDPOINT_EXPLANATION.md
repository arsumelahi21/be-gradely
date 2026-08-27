# Assignment Results Endpoint - Complete Guide

## Endpoint
```
GET /api/assignments/:assignmentId/results?studentId={studentProfileId}
```

## Purpose

**This endpoint allows users to view the result/grade for a specific student's submission to an assignment.**

It returns:
- The student's submission status (SUBMITTED, MARKED, or null if not submitted)
- Score and remarks (if marked)
- Download URL for the submission file
- Assignment details

---

## Who Can Use It?

### ✅ STUDENT
**Can view:** Their own results only

**Usage:**
```javascript
// Student doesn't need studentId - automatically uses logged-in student
GET /api/assignments/assignment-123/results
```

**Example:**
```javascript
// Student logged in as "John Doe"
const response = await fetch('/api/assignments/assignment-123/results', {
  headers: { 'Authorization': `Bearer ${studentToken}` }
});

const result = await response.json();
// Returns John Doe's result only
```

---

### ✅ PARENT
**Can view:** Their child's results

**Usage:**
```javascript
// Parent MUST provide studentId (their child's ID)
GET /api/assignments/assignment-123/results?studentId=student-profile-uuid
```

**Example:**
```javascript
// Parent logged in, viewing their child's result
const response = await fetch(
  '/api/assignments/assignment-123/results?studentId=child-student-uuid',
  {
    headers: { 'Authorization': `Bearer ${parentToken}` }
  }
);

const result = await response.json();
// Returns child's result
```

**Validation:**
- System verifies the `studentId` belongs to the parent's child
- If not, returns 403 Forbidden

---

### ✅ TEACHER
**Can view:** Any student's results for assignments they created

**Usage:**
```javascript
// Teacher MUST provide studentId
GET /api/assignments/assignment-123/results?studentId=student-profile-uuid
```

**Example:**
```javascript
// Teacher viewing a specific student's result
const response = await fetch(
  '/api/assignments/assignment-123/results?studentId=student-A-uuid',
  {
    headers: { 'Authorization': `Bearer ${teacherToken}` }
  }
);

const result = await response.json();
// Returns Student A's result
```

**Validation:**
- Teacher must be the creator of the assignment
- If not, returns 403 Forbidden

---

## Response Format

### Success: `200 OK`

**If student has submitted:**
```json
{
  "assignmentId": "1593ea68-3f8a-4229-b59d-840599e06a91",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "submission": {
    "id": "433a65e5-ce4c-46dc-9eeb-403aa532d7a2",
    "assignmentId": "1593ea68-3f8a-4229-b59d-840599e06a91",
    "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "status": "MARKED",
    "submittedAt": "2026-01-20T14:30:00.000Z",
    "markedAt": "2026-01-25T10:00:00.000Z",
    "score": 9,
    "remarks": "Good work, but missed question 3",
    "fileName": "homework.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 123456,
    "s3Key": "gradely/school/.../homework.pdf",
    "downloadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/...?X-Amz-Signature=...",
    "createdAt": "2026-01-20T14:20:00.000Z",
    "updatedAt": "2026-01-25T10:00:00.000Z"
  }
}
```

**If student hasn't submitted yet:**
```json
{
  "assignmentId": "1593ea68-3f8a-4229-b59d-840599e06a91",
  "studentId": "00ed8713-fc82-4819-8b45-1031933aabe0",
  "submission": null
}
```

---

## Use Cases

### Use Case 1: Student Views Their Grade
```javascript
// Student wants to see their score after teacher marked it
GET /api/assignments/assignment-123/results

// Response shows:
// - status: "MARKED"
// - score: 9
// - remarks: "Good work"
// - downloadUrl: (to view their submitted file)
```

### Use Case 2: Parent Checks Child's Grade
```javascript
// Parent wants to see their child's grade
GET /api/assignments/assignment-123/results?studentId=child-uuid

// Response shows child's result
```

### Use Case 3: Teacher Views Student's Result
```javascript
// Teacher wants to check a specific student's result
GET /api/assignments/assignment-123/results?studentId=student-A-uuid

// Response shows Student A's result
```

### Use Case 4: Check If Student Submitted
```javascript
// Check if student has submitted (submission will be null if not)
GET /api/assignments/assignment-123/results?studentId=student-B-uuid

// Response:
// {
//   "assignmentId": "...",
//   "studentId": "student-B-uuid",
//   "submission": null  // ← Not submitted yet
// }
```

---

## Business Rules

### ✅ Access Control
1. **STUDENT**: Can only view their own results (studentId ignored)
2. **PARENT**: Can view their child's results (studentId required, verified)
3. **TEACHER**: Can view any student's results for their assignments (studentId required)

### ✅ Validation
1. Assignment must exist
2. Student must be enrolled in the assignment's section
3. For STUDENT/PARENT: Assignment must be PUBLISHED or CLOSED
4. For PARENT: studentId must be their child
5. For TEACHER: Must be creator of the assignment

### ✅ Response Includes
- Submission status (SUBMITTED, MARKED, or null)
- Score and remarks (if marked)
- Download URL for submission file
- File metadata (fileName, mimeType, sizeBytes)

---

## Error Responses

### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": "studentId is required"
}
```
**When:** PARENT or TEACHER calls without `studentId` parameter

### 403 Forbidden
```json
{
  "statusCode": 403,
  "message": "Assignment is not published. Results are only available for published or closed assignments."
}
```
**When:** STUDENT/PARENT tries to view results for DRAFT assignment

```json
{
  "statusCode": 403,
  "message": "Only creator teacher can view results"
}
```
**When:** TEACHER tries to view results for assignment they didn't create

```json
{
  "statusCode": 403,
  "message": "Student not enrolled in section..."
}
```
**When:** Student is not enrolled in the assignment's section

### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "Assignment not found"
}
```
**When:** Assignment ID doesn't exist

---

## Complete Examples

### Example 1: Student Views Their Result
```javascript
// Student logged in
const response = await fetch(
  'http://localhost:3002/api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/results',
  {
    headers: {
      'Authorization': `Bearer ${studentToken}`
    }
  }
);

const result = await response.json();

if (result.submission) {
  if (result.submission.status === 'MARKED') {
    console.log('Score:', result.submission.score);
    console.log('Remarks:', result.submission.remarks);
    console.log('Download:', result.submission.downloadUrl);
  } else {
    console.log('Status:', result.submission.status); // "SUBMITTED" - not marked yet
  }
} else {
  console.log('Not submitted yet');
}
```

### Example 2: Parent Views Child's Result
```javascript
// Parent logged in, viewing child's result
const childStudentId = '00ed8713-fc82-4819-8b45-1031933aabe0';

const response = await fetch(
  `http://localhost:3002/api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/results?studentId=${childStudentId}`,
  {
    headers: {
      'Authorization': `Bearer ${parentToken}`
    }
  }
);

const result = await response.json();
console.log('Child\'s score:', result.submission?.score);
```

### Example 3: Teacher Views Student's Result
```javascript
// Teacher viewing specific student's result
const studentId = '00ed8713-fc82-4819-8b45-1031933aabe0';

const response = await fetch(
  `http://localhost:3002/api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/results?studentId=${studentId}`,
  {
    headers: {
      'Authorization': `Bearer ${teacherToken}`
    }
  }
);

const result = await response.json();
console.log('Student score:', result.submission?.score);
console.log('Remarks:', result.submission?.remarks);
```

---

## Frontend Implementation

### React Component Example
```jsx
function AssignmentResult({ assignmentId, studentId, userRole }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const url = studentId 
      ? `/api/assignments/${assignmentId}/results?studentId=${studentId}`
      : `/api/assignments/${assignmentId}/results`;

    fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
      .then(r => r.json())
      .then(data => {
        setResult(data);
        setLoading(false);
      });
  }, [assignmentId, studentId]);

  if (loading) return <div>Loading...</div>;

  if (!result.submission) {
    return <div>No submission yet</div>;
  }

  return (
    <div>
      <h3>Result</h3>
      <p>Status: {result.submission.status}</p>
      
      {result.submission.status === 'MARKED' && (
        <>
          <p>Score: {result.submission.score} / {assignment.maxScore}</p>
          <p>Remarks: {result.submission.remarks}</p>
          <a href={result.submission.downloadUrl} download>
            Download Submission
          </a>
        </>
      )}
      
      {result.submission.status === 'SUBMITTED' && (
        <p>Submitted, waiting for teacher to mark</p>
      )}
    </div>
  );
}
```

---

## Summary

### What This Endpoint Does
✅ **Returns a specific student's result for an assignment**
- Shows submission status (SUBMITTED, MARKED, or null)
- Shows score and remarks (if marked)
- Provides download URL for submission file

### Who Can Use It
- **STUDENT**: Their own results (no studentId needed)
- **PARENT**: Their child's results (studentId required)
- **TEACHER**: Any student's results for their assignments (studentId required)

### Key Points
1. **studentId parameter**: Required for PARENT and TEACHER, ignored for STUDENT
2. **Returns null submission**: If student hasn't submitted yet
3. **Includes download URL**: For viewing/downloading the submission file
4. **Access controlled**: Based on role and relationships

### When to Use
- Student wants to see their grade
- Parent wants to check child's grade
- Teacher wants to view a specific student's result
- Check if a student has submitted

