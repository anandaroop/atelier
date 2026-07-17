import type { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import type { S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { createApp } from "./app";

const s3Client = {} as S3Client;
const cloudFrontClient = {} as CloudFrontClient;

function buildApp() {
  return createApp({
    s3Client,
    cloudFrontClient,
    bucket: "artsy-atelier",
    distributionId: "E123EXAMPLE",
    publicDomain: "artsy.dev",
    maxUploadBytes: 52428800,
  });
}

describe("static drop-zone UI", () => {
  it("serves the drop-zone page at GET /", async () => {
    const res = await request(buildApp()).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain('id="dropzone"');
    expect(res.text).toContain('id="slug"');
    expect(res.text).toContain("/app.js");
    expect(res.text).toContain("/styles.css");
  });

  it("serves the client script with a JS content-type", async () => {
    const res = await request(buildApp()).get("/app.js");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
  });

  it("serves the stylesheet with a CSS content-type", async () => {
    const res = await request(buildApp()).get("/styles.css");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
  });
});
