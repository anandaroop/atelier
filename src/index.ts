import "dotenv/config";
import { S3Client } from "@aws-sdk/client-s3";
import express from "express";
import { loadConfig } from "./config";
import { createCheckRouter } from "./routes/check";

const config = loadConfig(process.env);
const s3Client = new S3Client({ region: config.s3Region });
const app = express();

app.get("/", (_req, res) => {
  res.type("text/plain").send("Atelier upload app — coming soon");
});

app.use(createCheckRouter(s3Client, config.s3Bucket));

app.listen(config.port, () => {
  console.log(`atelier listening on :${config.port}`);
});
