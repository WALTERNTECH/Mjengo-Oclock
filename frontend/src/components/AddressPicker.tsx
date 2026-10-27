import { LocateFixed, MapPin, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Place } from "../types";
import { MapView } from "./MapView";
import { Button, Notice } from "./ui";

// Address by search (geocoding auto-complete, US-01), by the phone's location, or by moving
// the pin on the map. The chosen point is what dispatch measures distance from.

export type PickedAddress = { label: string; lat: number; lng: number };

export function AddressPicker({
  value,
  onChange,
  error,
  showMap = true,
  scope = "nairobi",
}: {
  value: PickedAddress | null;
  onChange: (a: PickedAddress) => void;
  error?: string;
  showMap?: boolean;
  /** "kenya" for trades with out-of-station rates (site visits outside the Nairobi area). */
  scope?: "nairobi" | "kenya";
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) {
      setResults([]);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api.get<{ places: Place[]; unavailable?: boolean }>("/geo/search", { params: { q: text, scope, ...(value ? { lat: value.lat, lng: value.lng } : {}) } });
        if (n === seq.current) {
          setResults(r.data.places);
          setMsg(r.data.unavailable ? "Address search isn't responding. Move the pin on the map instead." : r.data.places.length ? null : "No matches. Try a road, estate or building name.");
        }
      } catch {
        if (n === seq.current) setMsg("Address search isn't responding. Move the pin on the map instead.");
      } finally {
        if (n === seq.current) setBusy(false);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const choose = (p: Place) => {
    onChange({ label: [p.label, p.detail].filter(Boolean).join(", "), lat: p.lat, lng: p.lng });
    setQ("");
    setResults([]);
    setMsg(null);
  };

  const reverse = async (p: { lat: number; lng: number }) => {
    onChange({ label: value?.label ?? "Pinned location", ...p });
    try {
      const r = await api.get<{ place: Place | null }>("/geo/reverse", { params: p });
      if (r.data.place) onChange({ label: [r.data.place.label, r.data.place.detail].filter(Boolean).join(", "), ...p });
      else onChange({ label: `Pinned location (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`, ...p });
    } catch {
      onChange({ label: `Pinned location (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})`, ...p });
    }
  };

  const locate = () => {
    if (!navigator.geolocation) return setMsg("This browser can't share your location. Search instead.");
    setLocating(true);
    setMsg(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        void reverse({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        setMsg("Location is blocked. Allow it in your browser settings, or search for the address.");
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  };

  return (
    <div className="stack g-10">
      <div className="input-group">
        <span className="prefix">{busy ? <span className="spinner" /> : <Search size={18} />}</span>
        <input className="input" placeholder={value ? "Search for a different address" : "Search a road, estate or building"} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search address" aria-invalid={error ? true : undefined} />
      </div>
      {results.length > 0 && (
        <div className="addr-results" role="listbox">
          {results.map((p, i) => (
            <button key={`${p.lat},${p.lng},${i}`} type="button" role="option" aria-selected={false} onClick={() => choose(p)}>
              <MapPin />
              <span className="stack">
                <span className="strong">{p.label}</span>
                {p.detail && <span className="small muted">{p.detail}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <Button size="sm" variant="ghost" icon={<LocateFixed />} loading={locating} onClick={locate} className="" style={{ alignSelf: "flex-start" }}>
        Use my current location
      </Button>
      {msg && <div className="small muted">{msg}</div>}
      {error && <div className="small red strong">{error}</div>}
      {value && (
        <div className="stack g-8">
          <div className="row g-8 small">
            <MapPin size={16} className="green" />
            <span className="strong grow">{value.label}</span>
          </div>
          {showMap && (
            <>
              <MapView job={value} onPick={(p) => void reverse(p)} />
              <div className="tiny muted">Drag the pin or tap the map to mark the exact spot.</div>
            </>
          )}
        </div>
      )}
      {!value && !results.length && !msg && (
        <Notice>{scope === "kenya" ? "Site visits are priced by location: within the Nairobi area, or out of station anywhere in Kenya." : "We cover Nairobi and the surrounding estates."}</Notice>
      )}
    </div>
  );
}
