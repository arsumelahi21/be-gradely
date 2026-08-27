# Mark Submission - Complete Guide

## How It Works

### Endpoint
```
PATCH /api/assignments/submissions/:submissionId/mark
```

### Authorization
- **Role:** `TEACHER` only
- **Access:** Only the creator teacher of the assignment can mark submissions

---

## Request

### Headers
```
Authorization: Bearer <token>
Content-Type: application/json
```

### Body
```json
{
  "score": 9,              // Optional, integer ≥ 0, cannot exceed maxScore
  "remarks": "Good work"   // Optional, string
}
```

**Validation:**
- At least one of `score` or `remarks` must be provided
- `score` cannot be negative
- `score` cannot exceed assignment's `maxScore` (if set)

---

## Response

### Success: `200 OK`
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
  "s3Key": "gradely/school/.../homework.pdf",
  "downloadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/...?X-Amz-Signature=...",
  "createdAt": "2026-01-20T14:20:00.000Z",
  "updatedAt": "2026-01-25T10:00:00.000Z",
  "assignment": {
    "id": "1593ea68-3f8a-4229-b59d-840599e06a91",
    "title": "Math Homework 1",
    "description": "Complete exercises 1-10",
    "dueAt": "2026-01-31T23:59:59.000Z",
    "maxScore": 10,
    "status": "PUBLISHED",
    "sectionSubject": {
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
      }
    },
    "academicYear": {
      "id": "ed8d614c-797d-4b61-a58c-bc9c1e080879",
      "name": "YEAR 2026",
      "code": "2026-2027"
    },
    "createdByTeacher": {
      "id": "408bd87e-06fe-4050-86d0-b72108a23044",
      "fullName": "opf-teacher-1"
    }
  },
  "student": {
    "id": "00ed8713-fc82-4819-8b45-1031933aabe0",
    "fullName": "John Doe",
    "rollNumber": "ST001",
    "email": "john.doe@example.com"
  }
}
```

---

## Business Rules

### ✅ What's Allowed
1. **Only SUBMITTED submissions** can be marked
2. **Only PUBLISHED or CLOSED assignments** can have submissions marked
3. **Only creator teacher** can mark submissions
4. **Re-marking allowed** - Can update score/remarks multiple times
5. **At least score OR remarks** must be provided

### ❌ What's Not Allowed
1. **Cannot mark UPLOADING submissions** - Must be SUBMITTED first
2. **Cannot mark DRAFT assignments** - Assignment must be PUBLISHED or CLOSED
3. **Cannot mark without score or remarks** - At least one required
4. **Score cannot exceed maxScore** - Validated against assignment's maxScore
5. **Score cannot be negative** - Must be ≥ 0

---

## Error Responses

### 400 Bad Request
```json
{
  "statusCode": 400,
  "message": "Cannot mark submission with status 'UPLOADING'. Only SUBMITTED submissions can be marked."
}
```

```json
{
  "statusCode": 400,
  "message": "Cannot mark submissions for assignment with status 'DRAFT'. Only PUBLISHED or CLOSED assignments can have submissions marked."
}
```

```json
{
  "statusCode": 400,
  "message": "Either score or remarks must be provided"
}
```

```json
{
  "statusCode": 400,
  "message": "Score (15) cannot exceed maxScore (10)"
}
```

### 403 Forbidden
```json
{
  "statusCode": 403,
  "message": "Only creator teacher can mark"
}
```

### 404 Not Found
```json
{
  "statusCode": 404,
  "message": "Submission not found"
}
```

---

## Complete Flow Example

### Step 1: List Submissions (Teacher)
```javascript
// Get all submissions for an assignment
const response = await fetch(
  'http://localhost:3002/api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/submissions',
  {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

const submissions = await response.json();
// Returns all submissions with status: UPLOADING, SUBMITTED, or MARKED
```

### Step 2: Mark a Submission
```javascript
// Mark a SUBMITTED submission
const markResponse = await fetch(
  'http://localhost:3002/api/assignments/submissions/433a65e5-ce4c-46dc-9eeb-403aa532d7a2/mark',
  {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      score: 9,
      remarks: 'Good work, but missed question 3'
    })
  }
);

const markedSubmission = await markResponse.json();
console.log('Marked:', markedSubmission.status); // "MARKED"
console.log('Score:', markedSubmission.score); // 9
console.log('Download URL:', markedSubmission.downloadUrl); // ✅ Included!
```

### Step 3: View Results (Student/Teacher/Parent)
```javascript
// Student views their own result
const resultsResponse = await fetch(
  'http://localhost:3002/api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/results',
  {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

const result = await resultsResponse.json();
console.log('My Score:', result.submission?.score);
console.log('Remarks:', result.submission?.remarks);
```

---

## Frontend Implementation Example

### React Component for Marking
```jsx
function MarkSubmissionForm({ submission, assignment, onMarked }) {
  const [score, setScore] = useState('');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleMark = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/assignments/submissions/${submission.id}/mark`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            score: score ? parseInt(score) : undefined,
            remarks: remarks || undefined
          })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message);
      }

      const marked = await response.json();
      onMarked(marked);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleMark}>
      {error && <div className="error">{error}</div>}
      
      <div>
        <label>
          Score (Max: {assignment.maxScore}):
          <input
            type="number"
            min="0"
            max={assignment.maxScore || undefined}
            value={score}
            onChange={(e) => setScore(e.target.value)}
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

      <button type="submit" disabled={loading || (!score && !remarks)}>
        {loading ? 'Marking...' : 'Mark Submission'}
      </button>
    </form>
  );
}
```

---

## What Was Fixed

### ✅ Fixed Issues
1. **Added submission status validation** - Can only mark SUBMITTED submissions
2. **Added assignment status validation** - Can only mark PUBLISHED/CLOSED assignments
3. **Require score or remarks** - At least one must be provided
4. **Full response data** - Returns complete submission with assignment, student, and downloadUrl
5. **Better error messages** - More descriptive error messages
6. **Score validation** - Cannot be negative

### ✅ Response Improvements
- Includes full assignment details
- Includes student information
- Includes downloadUrl for submission file
- Includes all submission metadata

---

## Summary

**How it works:**
1. Teacher lists submissions for an assignment
2. Teacher selects a SUBMITTED submission
3. Teacher provides score and/or remarks
4. System validates and marks the submission
5. Submission status changes to MARKED
6. Student can view their result

**Critical validations:**
- ✅ Submission must be SUBMITTED
- ✅ Assignment must be PUBLISHED or CLOSED
- ✅ Only creator teacher can mark
- ✅ Score cannot exceed maxScore
- ✅ At least score OR remarks required

**Response includes:**
- ✅ Full submission data
- ✅ Assignment details
- ✅ Student information
- ✅ Download URL for submission file

