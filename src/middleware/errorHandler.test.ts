import express from "express";
import request from "supertest";
import { errorHandler } from "./errorHandler";

function buildApp() {
  const app = express();

  app.get("/throws", () => {
    throw new Error("boom");
  });
  app.get("/rejects", async () => {
    throw new Error("async boom");
  });

  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("returns a JSON 500 for a synchronously thrown error", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    const res = await request(buildApp()).get("/throws");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(res.headers["content-type"]).toMatch(/json/);
    consoleError.mockRestore();
  });

  it("returns a JSON 500 for a rejected async handler", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    const res = await request(buildApp()).get("/rejects");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    consoleError.mockRestore();
  });

  it("logs the underlying error server-side", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    await request(buildApp()).get("/throws");

    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    consoleError.mockRestore();
  });

  it("defers to the next handler if headers were already sent", () => {
    const err = new Error("too late");
    const next = jest.fn();
    const res = {
      headersSent: true,
      status: jest.fn(),
      json: jest.fn(),
    } as unknown as express.Response;

    errorHandler(err, {} as express.Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
