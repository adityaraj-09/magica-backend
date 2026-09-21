import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ObjectStore, PutObjectInput, PutObjectResult } from "./types.js";

export type S3StoreConfig = {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  forcePathStyle?: boolean;
};

export function s3ConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): S3StoreConfig | null {
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  const publicBaseUrl = env.S3_PUBLIC_BASE_URL?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey || !publicBaseUrl) {
    return null;
  }
  return {
    bucket,
    region: env.S3_REGION?.trim() || "auto",
    endpoint: env.S3_ENDPOINT?.trim() || undefined,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: publicBaseUrl.replace(/\/$/, ""),
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
  };
}

export function createS3ObjectStore(config: S3StoreConfig): ObjectStore {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async put(input: PutObjectInput): Promise<PutObjectResult> {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
      return {
        key: input.key,
        url: `${config.publicBaseUrl}/${input.key}`,
        byteSize: input.body.byteLength,
      };
    },
  };
}
