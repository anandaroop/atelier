import { loadConfig } from "./config";

const base = {
  S3_BUCKET: "artsy-atelier",
  CLOUDFRONT_DISTRIBUTION_ID: "E123",
};

describe("loadConfig", () => {
  it("parses a complete env with correct types", () => {
    const cfg = loadConfig({ ...base, PORT: "3000", MAX_UPLOAD_BYTES: "1024" });
    expect(cfg.s3Bucket).toBe("artsy-atelier");
    expect(cfg.cloudfrontDistributionId).toBe("E123");
    expect(cfg.port).toBe(3000);
    expect(cfg.maxUploadBytes).toBe(1024);
  });

  it("applies defaults for optional vars", () => {
    const cfg = loadConfig(base);
    expect(cfg.s3Region).toBe("us-east-1");
    expect(cfg.publicDomain).toBe("artsy.dev");
    expect(cfg.port).toBe(8080);
    expect(cfg.maxUploadBytes).toBe(52428800);
  });

  it("throws naming every missing required var", () => {
    expect(() => loadConfig({})).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({})).toThrow(/CLOUDFRONT_DISTRIBUTION_ID/);
  });

  it("throws on a non-numeric numeric var", () => {
    expect(() => loadConfig({ ...base, PORT: "abc" })).toThrow(/PORT/);
  });
});
