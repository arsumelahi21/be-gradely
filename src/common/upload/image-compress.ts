import sharp from 'sharp';

// Formats sharp can re-encode losslessly-enough for our purposes. Everything
// else (svg, gif, pdf, docs, video…) passes through untouched.
const COMPRESSIBLE = /^image\/(jpe?g|png|webp)$/i;

/**
 * Shrink an image to fit `maxDim` at reduced quality (server-proxied uploads only;
 * presigned client->S3 uploads aren't touched). Fail-open: any error or non-smaller result returns the original buffer.
 */
export async function compressImage(
  buffer: Buffer,
  mimeType: string | undefined,
  maxDim = 1600,
  quality = 80,
): Promise<{ buffer: Buffer; mimeType: string | undefined }> {
  if (!mimeType || !COMPRESSIBLE.test(mimeType)) return { buffer, mimeType };
  try {
    const base = sharp(buffer)
      .rotate() // honor EXIF orientation before we strip metadata
      .resize({
        width: maxDim,
        height: maxDim,
        fit: 'inside',
        withoutEnlargement: true,
      });
    let out: Buffer;
    if (/png/i.test(mimeType)) {
      out = await base.png({ compressionLevel: 9, quality }).toBuffer();
    } else if (/webp/i.test(mimeType)) {
      out = await base.webp({ quality }).toBuffer();
    } else {
      out = await base.jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    return out.length < buffer.length
      ? { buffer: out, mimeType }
      : { buffer, mimeType };
  } catch {
    return { buffer, mimeType };
  }
}
