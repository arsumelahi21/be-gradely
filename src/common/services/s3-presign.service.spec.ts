import { BadRequestException } from '@nestjs/common';
import { S3PresignService } from './s3-presign.service';

describe('S3PresignService.presignPutObject', () => {
  const saved = { ...process.env };
  beforeAll(() => {
    // Signing is local: placeholder credentials never reach AWS.
    Object.assign(process.env, {
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_S3_BUCKET: 'test-bucket',
    });
  });
  afterAll(() => {
    process.env = saved;
  });
  const presign = (sizeBytes?: number) =>
    new S3PresignService({} as never).presignPutObject({
      key: 'school/x.pdf',
      contentType: 'application/pdf',
      sizeBytes,
      maxBytes: 5000,
    });

  it('signs the declared size, so S3 refuses a body of any other size', async () => {
    const { url } = await presign(1234);
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toContain(
      'content-length',
    );
  });

  it.each([undefined, 0, 5001])('refuses size %p', async (sizeBytes) => {
    await expect(presign(sizeBytes)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
