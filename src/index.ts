import "dotenv/config";
import express from "express";
import { loadConfig } from "./config";

const config = loadConfig(process.env);
const app = express();

app.get("/", (_req, res) => {
  res.type("text/plain").send("Atelier upload app — coming soon");
});

app.listen(config.port, () => {
  console.log(`atelier listening on :${config.port}`);
});
