# How to Display Uploaded Files in UI

## Issue Fixed ✅
- **Create Assignment**: Now returns full response with `downloadUrl` for each attachment
- **List Assignments**: Now includes `downloadUrl` for all attachments by default
- **Submit Assignment**: Returns `downloadUrl` for submitted file

---

## 1. Create Assignment - Get Response

### Frontend Code
```javascript
const formData = new FormData();
formData.append('academicYearId', 'ed8d614c-797d-4b61-a58c-bc9c1e080879');
formData.append('sectionSubjectId', '98c6bc9c-3438-4536-b56a-b6b10b74904a');
formData.append('title', '5th assignment');
formData.append('description', '5th assignment');
formData.append('dueAt', '2026-02-19T23:59:59.000Z');
formData.append('maxScore', '20');
formData.append('attachments', file); // File object

const response = await fetch('http://localhost:3002/api/assignments', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});

// ✅ IMPORTANT: Read the response!
const assignment = await response.json();
console.log('Created assignment:', assignment);
console.log('Attachments:', assignment.attachments);

// Display attachments
assignment.attachments?.forEach(att => {
  console.log('Download URL:', att.downloadUrl); // ✅ Now included!
});
```

### Response Example
```json
{
  "id": "6536540e-210d-41ed-8967-c3aefd4f4f3f",
  "title": "5th assignment",
  "attachments": [
    {
      "id": "f971ce60-d849-4258-86de-ad27cfa434d5",
      "fileName": "logo-1.png",
      "mimeType": "image/png",
      "sizeBytes": 988111,
      "s3Key": "gradely/school/.../logo-1.png",
      "downloadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/...?X-Amz-Signature=..."  // ✅ Included!
    }
  ]
}
```

---

## 2. List Assignments - Display Files

### Frontend Code
```javascript
// Get all assignments (download URLs included by default)
const response = await fetch('http://localhost:3002/api/assignments', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const assignments = await response.json();

// Display assignments with attachments
assignments.forEach(assignment => {
  console.log('Assignment:', assignment.title);
  
  assignment.attachments?.forEach(attachment => {
    console.log('File:', attachment.fileName);
    console.log('Download URL:', attachment.downloadUrl); // ✅ Included!
  });
});
```

### Response Example
```json
[
  {
    "id": "6536540e-210d-41ed-8967-c3aefd4f4f3f",
    "title": "5th assignment",
    "attachments": [
      {
        "id": "f971ce60-d849-4258-86de-ad27cfa434d5",
        "fileName": "logo-1.png",
        "mimeType": "image/png",
        "sizeBytes": 988111,
        "downloadUrl": "https://gradely-school.s3.eu-north-1.amazonaws.com/...?X-Amz-Signature=..."  // ✅ Included!
      }
    ]
  }
]
```

---

## 3. Display Files in React/UI

### Display Images
```jsx
{assignment.attachments?.map(att => {
  if (att.mimeType?.startsWith('image/')) {
    return (
      <div key={att.id}>
        <img 
          src={att.downloadUrl} 
          alt={att.fileName}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
        <p>{att.fileName}</p>
      </div>
    );
  }
  return null;
})}
```

### Display Download Links
```jsx
{assignment.attachments?.map(att => (
  <a 
    key={att.id}
    href={att.downloadUrl}
    download={att.fileName}
    target="_blank"
    rel="noopener noreferrer"
  >
    📎 {att.fileName} ({(att.sizeBytes / 1024).toFixed(2)} KB)
  </a>
))}
```

### Display PDFs in iframe
```jsx
{assignment.attachments?.map(att => {
  if (att.mimeType === 'application/pdf') {
    return (
      <iframe
        key={att.id}
        src={att.downloadUrl}
        width="100%"
        height="600px"
        title={att.fileName}
      />
    );
  }
  return null;
})}
```

### Complete Example Component
```jsx
function AssignmentCard({ assignment }) {
  return (
    <div className="assignment-card">
      <h3>{assignment.title}</h3>
      <p>{assignment.description}</p>
      
      {assignment.attachments && assignment.attachments.length > 0 && (
        <div className="attachments">
          <h4>Attachments:</h4>
          {assignment.attachments.map(att => (
            <div key={att.id} className="attachment">
              {att.mimeType?.startsWith('image/') ? (
                <img 
                  src={att.downloadUrl} 
                  alt={att.fileName}
                  style={{ maxWidth: '300px' }}
                />
              ) : (
                <a 
                  href={att.downloadUrl}
                  download={att.fileName}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  📎 {att.fileName} ({(att.sizeBytes / 1024).toFixed(2)} KB)
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## 4. Important Notes

### Download URL Expiry
- **Expires in:** 15 minutes (900 seconds)
- **Configurable via:** `AWS_S3_PRESIGN_EXPIRES_IN_SECONDS` environment variable
- **Solution:** If URL expires, call the API again to get a new URL

### Getting Fresh URLs
If you need fresh download URLs (e.g., after 15 minutes):

```javascript
// Option 1: Include download URLs in list request (already default)
GET /api/assignments

// Option 2: Request download URL for specific attachment
GET /api/assignments/:assignmentId/attachments/:attachmentId/request-download
```

### File Types Supported
- **Images:** `image/png`, `image/jpeg`, `image/gif`, etc. - Use in `<img>` tag
- **PDFs:** `application/pdf` - Use in `<iframe>` or download link
- **Documents:** `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` - Download link
- **Others:** Any file type - Download link

---

## 5. Troubleshooting

### Issue: Not receiving response payload
**Solution:** Make sure you're reading the response:
```javascript
const response = await fetch(...);
const data = await response.json(); // ✅ Don't forget this!
```

### Issue: Download URL is null/undefined
**Possible causes:**
1. Attachment status is not `READY`
2. `s3Key` is missing
3. S3 configuration issue

**Check:**
```javascript
console.log('Attachment:', attachment);
console.log('Status:', attachment.status); // Should be "READY"
console.log('S3 Key:', attachment.s3Key); // Should exist
```

### Issue: CORS error when accessing download URL
**Solution:** Configure CORS on your S3 bucket (see `S3_CORS_CONFIGURATION.md`)

### Issue: Download URL expired
**Solution:** Call the API again to get fresh URLs:
```javascript
// Refresh assignment with new download URLs
const response = await fetch(`/api/assignments/${assignmentId}`, {
  headers: { 'Authorization': `Bearer ${token}` }
});
const updatedAssignment = await response.json();
```

---

## 6. Complete Example

```javascript
async function createAndDisplayAssignment(file, token) {
  // 1. Create assignment
  const formData = new FormData();
  formData.append('academicYearId', 'ed8d614c-797d-4b61-a58c-bc9c1e080879');
  formData.append('sectionSubjectId', '98c6bc9c-3438-4536-b56a-b6b10b74904a');
  formData.append('title', 'My Assignment');
  formData.append('attachments', file);

  const createResponse = await fetch('/api/assignments', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: formData
  });

  const assignment = await createResponse.json(); // ✅ Read response!
  
  // 2. Display attachments
  assignment.attachments?.forEach(att => {
    console.log('File:', att.fileName);
    console.log('Download URL:', att.downloadUrl); // ✅ Available!
    
    // Use in UI
    if (att.mimeType?.startsWith('image/')) {
      // Display as image
      const img = document.createElement('img');
      img.src = att.downloadUrl;
      img.alt = att.fileName;
      document.body.appendChild(img);
    } else {
      // Display as download link
      const link = document.createElement('a');
      link.href = att.downloadUrl;
      link.download = att.fileName;
      link.textContent = `Download ${att.fileName}`;
      document.body.appendChild(link);
    }
  });

  return assignment;
}
```

---

## Summary

✅ **Fixed Issues:**
1. Create assignment now returns full response with download URLs
2. List assignments now includes download URLs by default
3. All async operations properly awaited

✅ **How to Use:**
1. Always read the response: `await response.json()`
2. Access `downloadUrl` from `assignment.attachments[].downloadUrl`
3. Use `downloadUrl` in `<img>`, `<iframe>`, or `<a>` tags
4. URLs expire in 15 minutes - refresh if needed

