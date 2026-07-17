import mime from "mime-types";

export function resolveContentType(path: string): string {
  return mime.lookup(path) || "application/octet-stream";
}
