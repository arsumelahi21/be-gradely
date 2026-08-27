# S3 CORS Configuration for File Uploads

## Problem
When the frontend tries to upload files directly to S3 using presigned URLs, it gets a CORS error because the S3 bucket doesn't have CORS configured to allow cross-origin requests.

## Solution: Configure CORS on S3 Bucket

### Step 1: Go to AWS S3 Console
1. Log in to [AWS Console](https://console.aws.amazon.com/)
2. Navigate to **S3** service
3. Click on your bucket: `gradely-school`

### Step 2: Configure CORS
1. Click on the **Permissions** tab
2. Scroll down to **Cross-origin resource sharing (CORS)**
3. Click **Edit**
4. Paste the following CORS configuration:

```json
[
    {
        "AllowedHeaders": [
            "*"
        ],
        "AllowedMethods": [
            "GET",
            "PUT",
            "POST",
            "DELETE",
            "HEAD"
        ],
        "AllowedOrigins": [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:8080",
            "https://your-production-domain.com"
        ],
        "ExposeHeaders": [
            "ETag",
            "x-amz-server-side-encryption",
            "x-amz-request-id",
            "x-amz-id-2"
        ],
        "MaxAgeSeconds": 3000
    }
]
```

### Step 3: Save Configuration
1. Click **Save changes**
2. Wait a few seconds for the configuration to propagate

---

## CORS Configuration Explained

### For Development (All Localhost Ports)
```json
[
    {
        "AllowedHeaders": ["*"],
        "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
        "AllowedOrigins": [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:8080"
        ],
        "ExposeHeaders": [
            "ETag",
            "x-amz-server-side-encryption",
            "x-amz-request-id",
            "x-amz-id-2"
        ],
        "MaxAgeSeconds": 3000
    }
]
```

### For Production (Specific Domain)
```json
[
    {
        "AllowedHeaders": [
            "Authorization",
            "Content-Type",
            "Content-Length",
            "x-amz-content-sha256",
            "x-amz-date",
            "x-amz-security-token"
        ],
        "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
        "AllowedOrigins": [
            "https://your-frontend-domain.com",
            "https://www.your-frontend-domain.com"
        ],
        "ExposeHeaders": [
            "ETag",
            "x-amz-server-side-encryption",
            "x-amz-request-id",
            "x-amz-id-2"
        ],
        "MaxAgeSeconds": 3000
    }
]
```

### For Development + Production (Combined)
```json
[
    {
        "AllowedHeaders": ["*"],
        "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
        "AllowedOrigins": [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:8080",
            "https://your-production-domain.com"
        ],
        "ExposeHeaders": [
            "ETag",
            "x-amz-server-side-encryption",
            "x-amz-request-id",
            "x-amz-id-2"
        ],
        "MaxAgeSeconds": 3000
    }
]
```

---

## Using AWS CLI (Alternative Method)

If you prefer using AWS CLI:

```bash
# Create a CORS configuration file
cat > cors-config.json << 'EOF'
{
    "CORSRules": [
        {
            "AllowedHeaders": ["*"],
            "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
            "AllowedOrigins": [
                "http://localhost:3000",
                "http://localhost:3001",
                "http://localhost:3002",
                "http://localhost:5173",
                "http://localhost:5174",
                "http://localhost:8080"
            ],
            "ExposeHeaders": [
                "ETag",
                "x-amz-server-side-encryption",
                "x-amz-request-id",
                "x-amz-id-2"
            ],
            "MaxAgeSeconds": 3000
        }
    ]
}
EOF

# Apply CORS configuration
aws s3api put-bucket-cors \
    --bucket gradely-school \
    --cors-configuration file://cors-config.json \
    --region eu-north-1
```

---

## Verify CORS Configuration

### Using AWS CLI
```bash
aws s3api get-bucket-cors --bucket gradely-school --region eu-north-1
```

### Using Browser DevTools
After configuring CORS, try uploading again. In the Network tab, check:
- The preflight OPTIONS request should return `200 OK`
- The PUT request should succeed without CORS errors

---

## Important Notes

1. **Wildcard Origins**: Using `"AllowedOrigins": ["*"]` is **NOT recommended** for production. Always specify exact origins.

2. **AllowedHeaders**: Using `["*"]` allows all headers, which is fine for presigned URLs. For production, you might want to be more specific:
   ```json
   "AllowedHeaders": [
       "Authorization",
       "Content-Type",
       "Content-Length",
       "x-amz-*"
   ]
   ```

3. **MaxAgeSeconds**: This is how long browsers cache the CORS preflight response. `3000` seconds = 50 minutes.

4. **Propagation**: CORS changes can take a few seconds to propagate. If it doesn't work immediately, wait 10-30 seconds and try again.

5. **HTTPS vs HTTP**: Make sure your `AllowedOrigins` match exactly:
   - `http://localhost:3000` ≠ `https://localhost:3000`
   - Include both if needed

---

## Troubleshooting

### Still Getting CORS Error?

1. **Check the exact origin in the error message**
   - The error will show: `Access-Control-Allow-Origin: http://localhost:XXXX`
   - Make sure that exact origin is in your `AllowedOrigins` list

2. **Check browser console for preflight request**
   - Look for an OPTIONS request to the S3 URL
   - It should return `200 OK` with CORS headers

3. **Verify bucket name**
   - Make sure you're configuring CORS on the correct bucket: `gradely-school`

4. **Check region**
   - Your bucket is in `eu-north-1` region
   - Make sure you're configuring the correct bucket in that region

5. **Clear browser cache**
   - Sometimes browsers cache CORS preflight responses
   - Try hard refresh (Cmd+Shift+R / Ctrl+Shift+R)

---

## Testing CORS Configuration

After configuring CORS, test with this curl command:

```bash
# Test preflight (OPTIONS) request
curl -X OPTIONS \
  "https://gradely-school.s3.eu-north-1.amazonaws.com/gradely/test.txt" \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: Content-Type" \
  -v
```

You should see these headers in the response:
```
< Access-Control-Allow-Origin: http://localhost:3000
< Access-Control-Allow-Methods: GET, PUT, POST, DELETE, HEAD
< Access-Control-Allow-Headers: *
```

---

## Security Best Practices

### For Production:
1. **Never use `"*"` for AllowedOrigins** - Always specify exact domains
2. **Limit AllowedMethods** - Only include methods you actually use
3. **Limit AllowedHeaders** - Only include headers you need
4. **Use HTTPS** - Always use HTTPS origins in production

### Example Production CORS:
```json
[
    {
        "AllowedHeaders": [
            "Content-Type",
            "Content-Length",
            "x-amz-content-sha256",
            "x-amz-date"
        ],
        "AllowedMethods": ["GET", "PUT"],
        "AllowedOrigins": [
            "https://app.yourdomain.com",
            "https://www.yourdomain.com"
        ],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3600
    }
]
```

