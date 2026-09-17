import { BadRequestException } from '@nestjs/common';

/**
 * Server-side allow-list + size cap for uploaded attachments (PLAN.md P0-13g).
 * Enforced on BOTH presign and persist — never trust the browser-reported type/size.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
]);

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Scanned exam papers routinely exceed the 5 MB attachment cap.
export const MAX_EXAM_PAPER_BYTES = 10 * 1024 * 1024;

/**
 * Checks the `%PDF-` header too when bytes are on hand, so a renamed non-PDF is rejected; on the
 * presign path (no bytes) the declared type is trusted and the signed Content-Type keeps S3 honest.
 */
export function assertPdfOnly(input: {
  mimeType?: string | null;
  fileName?: string | null;
  buffer?: Buffer;
}): void {
  const mt = (input.mimeType ?? '').toLowerCase();
  const name = (input.fileName ?? '').toLowerCase();
  const declaredPdf =
    mt === 'application/pdf' ||
    ((mt === 'application/octet-stream' || mt === '') && name.endsWith('.pdf'));
  const bytesOk = input.buffer
    ? input.buffer.subarray(0, 5).toString('latin1') === '%PDF-'
    : true;
  if (!declaredPdf || !bytesOk) {
    throw new BadRequestException('Only PDF files are accepted');
  }
}

export function assertAttachmentAllowed(input: {
  mimeType?: string | null;
  sizeBytes?: number | null;
}): void {
  if (!input.mimeType || !ALLOWED_ATTACHMENT_MIME_TYPES.has(input.mimeType)) {
    throw new BadRequestException(
      `Attachment type "${input.mimeType ?? 'unknown'}" is not allowed`,
    );
  }
  if (
    typeof input.sizeBytes === 'number' &&
    input.sizeBytes > MAX_ATTACHMENT_BYTES
  ) {
    throw new BadRequestException(
      `Attachment exceeds the ${Math.round(
        MAX_ATTACHMENT_BYTES / (1024 * 1024),
      )}MB limit`,
    );
  }
}
