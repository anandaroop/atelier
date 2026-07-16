import type { S3Client } from "@aws-sdk/client-s3";
import express from "express";
import request from "supertest";
import { headIndex } from "../lib/s3";
import { createCheckRouter } from "./check";

jest.mock("../lib/s3");

const mockHeadIndex = headIndex as jest.MockedFunction<typeof headIndex>;
const client = {} as S3Client;
const bucket = "artsy-atelier";

function buildApp() {
  const app = express();
  app.use(createCheckRouter(client, bucket));
  return app;
}

beforeEach(() => {
  mockHeadIndex.mockReset();
});

describe("GET /check", () => {
  it("returns exists: false for a non-existent slug", async () => {
    mockHeadIndex.mockResolvedValue({ exists: false });

    const res = await request(buildApp()).get("/check?slug=new-site");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: false });
    expect(mockHeadIndex).toHaveBeenCalledWith(client, bucket, "new-site");
  });

  it("returns the prior uploader and timestamp for an existing slug", async () => {
    mockHeadIndex.mockResolvedValue({
      exists: true,
      uploadedBy: "roop@artsymail.com",
      uploadedAt: "2026-07-16T12:00:00.000Z",
    });

    const res = await request(buildApp()).get("/check?slug=marketing-dashboard");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      exists: true,
      uploadedBy: "roop@artsymail.com",
      uploadedAt: "2026-07-16T12:00:00.000Z",
    });
  });

  it("rejects an invalid slug with a 4xx and clear message", async () => {
    const res = await request(buildApp()).get("/check?slug=Not_Valid");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowercase/i);
    expect(mockHeadIndex).not.toHaveBeenCalled();
  });

  it("rejects a reserved slug with a 4xx and clear message", async () => {
    const res = await request(buildApp()).get("/check?slug=admin");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reserved/i);
    expect(mockHeadIndex).not.toHaveBeenCalled();
  });

  it("rejects a missing slug param with a 4xx", async () => {
    const res = await request(buildApp()).get("/check");

    expect(res.status).toBe(400);
    expect(mockHeadIndex).not.toHaveBeenCalled();
  });
});
