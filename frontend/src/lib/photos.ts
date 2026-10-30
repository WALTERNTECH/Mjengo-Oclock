/**
 * Phone photos run to 5–10 MB, and the server keeps at most 1600 px of any photo, so a photo
 * is scaled to 2000 px and saved as JPEG before upload. That keeps several photos inside one
 * request's size limit, uploads faster on mobile data, and drops the photo's location data.
 * Small files, and anything the browser can't decode, go up as they are.
 */
export async function shrinkPhoto(f: File, maxEdge = 2000): Promise<File> {
  if (f.size < 800_000) return f;
  try {
    const img = await createImageBitmap(f, { imageOrientation: "from-image" });
    const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * k);
    canvas.height = Math.round(img.height * k);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.close();
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/jpeg", 0.85));
    if (!blob || blob.size >= f.size) return f;
    return new File([blob], `${f.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, { type: "image/jpeg" });
  } catch {
    return f;
  }
}
