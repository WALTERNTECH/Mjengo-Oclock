import multer from "multer";
import sharp from "sharp";
import { one, type Q } from "../config/db.js";
import { badRequest } from "./http.js";
import { signMedia } from "./security.js";

// Every photo is private: job photos show the inside of someone's home, and ID documents
// and selfies are personal data. Images go through sharp (orientation fixed, metadata and
// location stripped, resized, WebP), are kept in Postgres, and are served only through
// short-lived signed links handed to the people allowed to see them.

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif"]);
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 4 } });

export type MediaKind = "job" | "extra" | "dispute" | "completion" | "report" | "no_show" | "id_front" | "selfie" | "certificate";

export async function storeImage(q: Q, ownerId: string, kind: MediaKind, file: { buffer: Buffer; mimetype: string }, maxEdge = 1600): Promise<string> {
  if (!ACCEPTED.has(file.mimetype)) throw badRequest("Upload a JPEG, PNG, WebP or HEIC photo");
  let out: { data: Buffer; info: { width: number; height: number } };
  try {
    out = await sharp(file.buffer, { failOn: "error" })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw badRequest("That file could not be read as an image");
  }
  const row = await one<{ id: string }>(q, `insert into media (owner_id, kind, mime, bytes, width, height) values ($1, $2, 'image/webp', $3, $4, $5) returning id`, [
    ownerId,
    kind,
    out.data,
    out.info.width,
    out.info.height,
  ]);
  return row!.id;
}

export const mediaUrl = (id: string | null | undefined) => (id ? signMedia(id) : null);
