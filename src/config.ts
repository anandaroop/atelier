export interface Config {
  s3Bucket: string;
  s3Region: string;
  cloudfrontDistributionId: string;
  publicDomain: string;
  maxUploadBytes: number;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing: string[] = [];

  const required = (name: string): string => {
    const value = env[name];
    if (!value) {
      missing.push(name);
    }
    return value ?? "";
  };

  const s3Bucket = required("S3_BUCKET");
  const cloudfrontDistributionId = required("CLOUDFRONT_DISTRIBUTION_ID");

  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }

  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined) {
      return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Env var ${name} must be a number, got "${raw}"`);
    }
    return parsed;
  };

  return {
    s3Bucket,
    cloudfrontDistributionId,
    s3Region: env.S3_REGION ?? "us-east-1",
    publicDomain: env.PUBLIC_DOMAIN ?? "artsy.dev",
    maxUploadBytes: num("MAX_UPLOAD_BYTES", 52428800),
    port: num("PORT", 8080),
  };
}
