# Assignment Upload Flow - Frontend Validation

## ✅ Step 1: Request Upload URL (CORRECT)

**Request:**
```http
POST /api/assignments/1593ea68-3f8a-4229-b59d-840599e06a91/submissions/request-upload
Authorization: Bearer <token>
Content-Type: application/json

{
  "fileName": "logo-1.png",
  "mimeType": "image/png",
  "sizeBytes": 988111
}
```

**Response:** ✅ Correct
```json
{
  "submissionId": "433a65e5-ce4c-46dc-9eeb-403aa532d7a2",
  "s3Key": "gradely/school/.../logo-1.png",
  "uploadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/...?X-Amz-Algorithm=..."
}
```

---

## ⚠️ Step 2: Upload File to S3 (IMPORTANT)

### ❌ DO NOT send query parameters as headers

The query parameters (`X-Amz-Algorithm`, `X-Amz-Signature`, etc.) are **already part of the URL**. Do NOT extract them and send as separate headers.

### ✅ Correct Implementation

```javascript
// Step 2: Upload file directly to S3
const file = // ... your file object

const uploadResponse = await fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'Content-Type': 'image/png',  // Use the mimeType from Step 1
    // DO NOT add X-Amz-* headers - they're already in the URL!
  },
  body: file  // Raw file binary (File, Blob, or ArrayBuffer)
});

if (uploadResponse.ok) {
  console.log('File uploaded successfully');
} else {
  console.error('Upload failed:', uploadResponse.status, uploadResponse.statusText);
}
```

### ✅ Alternative: Using FormData (if needed)

```javascript
const formData = new FormData();
formData.append('file', file);

// For presigned URLs, use PUT with raw file, not FormData
// FormData is for multipart/form-data, presigned URLs expect raw binary
```

### ✅ Using XMLHttpRequest (if you need upload progress)

```javascript
const xhr = new XMLHttpRequest();

xhr.upload.addEventListener('progress', (e) => {
  if (e.lengthComputable) {
    const percentComplete = (e.loaded / e.total) * 100;
    console.log(`Upload progress: ${percentComplete}%`);
  }
});

xhr.open('PUT', uploadUrl);
xhr.setRequestHeader('Content-Type', 'image/png');  // Use mimeType from Step 1
xhr.send(file);  // Send raw file

xhr.onload = () => {
  if (xhr.status === 200) {
    console.log('Upload successful');
  } else {
    console.error('Upload failed:', xhr.status);
  }
};
```

---

## ✅ Step 3: Submit Assignment (REQUIRED)

After successful upload to S3, call the submit endpoint:

```javascript
// Step 3: Mark submission as complete
const submitResponse = await fetch(
  `http://localhost:3002/api/assignments/${assignmentId}/submissions/${submissionId}/submit`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    }
    // No body needed
  }
);

const submission = await submitResponse.json();
console.log('Submission status:', submission.status);  // Should be "SUBMITTED"
```

---

## Common Mistakes to Avoid

### ❌ Mistake 1: Sending query parameters as headers
```javascript
// WRONG - Don't do this!
fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',  // ❌ Already in URL
    'X-Amz-Signature': '...',                // ❌ Already in URL
    // etc.
  }
});
```

### ❌ Mistake 2: Using POST instead of PUT
```javascript
// WRONG - Presigned URLs for uploads use PUT
fetch(uploadUrl, {
  method: 'POST',  // ❌ Should be PUT
  body: file
});
```

### ❌ Mistake 3: Wrong Content-Type
```javascript
// WRONG - Use the exact mimeType from Step 1
fetch(uploadUrl, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/octet-stream'  // ❌ Use actual mimeType
  },
  body: file
});
```

### ❌ Mistake 4: Forgetting to call submit endpoint
```javascript
// WRONG - Always call submit after upload
await fetch(uploadUrl, { method: 'PUT', body: file });
// ❌ Missing: Call submit endpoint to mark as SUBMITTED
```

---

## Complete Example (React/TypeScript)

```typescript
async function submitAssignment(
  assignmentId: string,
  file: File,
  token: string
) {
  try {
    // Step 1: Request upload URL
    const uploadRequestResponse = await fetch(
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

    if (!uploadRequestResponse.ok) {
      throw new Error('Failed to request upload URL');
    }

    const { submissionId, uploadUrl } = await uploadRequestResponse.json();

    // Step 2: Upload file to S3
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type  // Use exact mimeType
      },
      body: file  // Raw file
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }

    // Step 3: Submit assignment
    const submitResponse = await fetch(
      `http://localhost:3002/api/assignments/${assignmentId}/submissions/${submissionId}/submit`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (!submitResponse.ok) {
      throw new Error('Failed to submit assignment');
    }

    const submission = await submitResponse.json();
    return submission;

  } catch (error) {
    console.error('Assignment submission error:', error);
    throw error;
  }
}
```

---

## Response Status Codes

### Step 1 (Request Upload URL)
- `201 Created`: Success
- `404 Not Found`: Assignment not found
- `403 Forbidden`: Assignment not published, or student not enrolled

### Step 2 (Upload to S3)
- `200 OK`: Upload successful
- `403 Forbidden`: Presigned URL expired or invalid
- `400 Bad Request`: Content-Type mismatch or other S3 error

### Step 3 (Submit)
- `200 OK`: Submission marked as SUBMITTED
- `404 Not Found`: Submission not found
- `400 Bad Request`: Already marked, or mismatched IDs
- `403 Forbidden`: Not the submission owner

---

## Important Notes

1. **Presigned URL Expiry**: The upload URL expires in 15 minutes (900 seconds). Upload must complete within this time.

2. **Content-Type**: Must match the `mimeType` sent in Step 1. S3 validates this.

3. **File Size**: The actual uploaded file size should match `sizeBytes` from Step 1 (though S3 doesn't strictly enforce this).

4. **Idempotency**: If you call Step 1 multiple times, it will update the existing submission record (upsert). Each call generates a new S3 key and presigned URL.

5. **Error Handling**: If Step 2 (S3 upload) fails, you can retry Step 1 to get a new presigned URL. However, calling Step 3 will fail if the file wasn't actually uploaded to S3.

