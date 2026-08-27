import { Injectable } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

@Injectable()
export class S3PresignService {
  private readonly s3: S3Client;

  constructor(private readonly prisma: PrismaService) {
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error('AWS_REGION is not set');
    }

    this.s3 = new S3Client({
      region,
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }

  /**
   * Builds an object key namespaced by the school's `code` (multi-tenant foldering under
   * `{schoolCode}/…`); null schoolId (super-admin) falls back to `_platform`.
   */
  async keyForSchool(
    schoolId: string | null | undefined,
    tail: string,
  ): Promise<string> {
    const root = schoolId ? await this.schoolCode(schoolId) : '_platform';
    return `${root}/${tail.replace(/^\/+/, '')}`;
  }

  /**
   * Uniform per-tenant object key: `{schoolCode}/{category}/{userId}/{uuid}-{file}`
   * (uuid prefix avoids collisions within a user's folder).
   */
  async keyFor(
    schoolId: string | null | undefined,
    category: string,
    userId: string | null | undefined,
    fileName: string,
  ): Promise<string> {
    const user = sanitize(userId || '_unknown');
    const cat = sanitize(category || 'misc');
    const name = sanitize(fileName || 'file');
    return this.keyForSchool(
      schoolId,
      `${cat}/${user}/${randomUUID()}-${name}`,
    );
  }

  private async schoolCode(schoolId: string): Promise<string> {
    const school = await this.prisma.school.findUnique({
      where: { id: schoolId },
      select: { code: true },
    });
    if (!school?.code) {
      throw new Error(`School ${schoolId} not found while building S3 key`);
    }
    // Codes are @unique and URL-safe by convention; sanitize defensively.
    return school.code.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private bucket(): string {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) throw new Error('AWS_S3_BUCKET is not set');
    return bucket;
  }

  private expiresInSeconds(): number {
    const raw = process.env.AWS_S3_PRESIGN_EXPIRES_IN_SECONDS ?? '900';
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 900;
  }

  async presignPutObject(input: { key: string; contentType?: string }) {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: input.key,
      ContentType: input.contentType,
    });

    const url = await getSignedUrl(this.s3, cmd, {
      expiresIn: this.expiresInSeconds(),
    });

    return { url, bucket: this.bucket(), key: input.key };
  }

  async presignGetObject(input: {
    key: string;
  }): Promise<{ url: string | null; bucket: string | null; key: string }> {
    // Degrades gracefully when S3 isn't configured (e.g. local dev): returns a null URL
    // instead of throwing, so display-only views don't 500. Uploads still require real config.
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      return { url: null, bucket: null, key: input.key };
    }

    const cmd = new GetObjectCommand({
      Bucket: bucket,
      Key: input.key,
    });

    const url = await getSignedUrl(this.s3, cmd, {
      expiresIn: this.expiresInSeconds(),
    });

    return { url, bucket, key: input.key };
  }

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType?: string;
    contentDisposition?: string;
  }) {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket(),
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentDisposition: input.contentDisposition,
    });

    await this.s3.send(cmd);
    return { bucket: this.bucket(), key: input.key };
  }

  /** Fetch an object's raw bytes (used to stream S3-stored images through the API). */
  async getObjectBuffer(key: string): Promise<Buffer> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket(), Key: key });
    const res = await this.s3.send(cmd);
    // Node runtime: Body is a Readable stream.
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
