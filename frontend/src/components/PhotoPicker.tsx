import { Camera, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { shrinkPhoto } from "../lib/photos";

/** Up to `max` photos from the camera or gallery, previewed before upload. */
export function PhotoPicker({ files, onChange, max = 3, label = "Add photo", capture }: { files: File[]; onChange: (f: File[]) => void; max?: number; label?: string; capture?: "user" | "environment" }) {
  const input = useRef<HTMLInputElement>(null);
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return (
    <div className="photos">
      {urls.map((u, i) => (
        <div className="photo" key={u}>
          <img src={u} alt={`Photo ${i + 1}`} />
          <button type="button" className="x" aria-label="Remove photo" onClick={() => onChange(files.filter((_, j) => j !== i))}>
            <X />
          </button>
        </div>
      ))}
      {files.length < max && (
        <button type="button" className="photo-add" onClick={() => input.current?.click()}>
          <Camera />
          {label}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture={capture}
        multiple={max - files.length > 1}
        hidden
        onChange={async (e) => {
          const picked = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
          e.target.value = "";
          onChange([...files, ...(await Promise.all(picked.slice(0, max - files.length).map((f) => shrinkPhoto(f))))]);
        }}
      />
    </div>
  );
}

/** A single document photo (ID, selfie, certificate) with its current upload. */
export function DocPicker({ title, hint, current, onPick, busy, capture }: { title: string; hint: string; current: string | null; onPick: (f: File) => void; busy?: boolean; capture?: "user" | "environment" }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="doc-tile">
      {current ? <img className="doc-thumb" src={current} alt="" /> : <div className="doc-thumb"><Camera /></div>}
      <div className="grow stack g-4">
        <div className="strong">{title}</div>
        <div className="small muted">{current ? "Uploaded" : hint}</div>
      </div>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <span className="spinner" /> : null}
        {current ? "Replace" : "Upload"}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture={capture}
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) onPick(await shrinkPhoto(f));
        }}
      />
    </div>
  );
}
