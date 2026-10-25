import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { HttpError } from "../utils/http.js";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path}` } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return res.status(400).json({ error: { code: "validation", message: details[0]?.message ?? "Check the highlighted fields", details } });
  }
  if (err instanceof MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "That file is larger than 12 MB" : "The upload could not be read";
    return res.status(400).json({ error: { code: "upload", message } });
  }
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "bad_json", message: "The request body is not valid JSON" } });
  }
  console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: { code: "internal", message: "Something went wrong on our side" } });
}
