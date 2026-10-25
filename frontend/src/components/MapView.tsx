import { useEffect, useRef, useState } from "react";
import { useConfig } from "../context/AuthContext";

// Leaflet, loaded only on screens that show a map so the home page stays light on 3G.

type LatLng = { lat: number; lng: number };
type Props = {
  job?: LatLng | null;
  worker?: (LatLng & { stale?: boolean }) | null;
  /** Lets the person drag the job pin or tap the map to place it. */
  onPick?: (p: LatLng) => void;
  className?: string;
  zoom?: number;
};

type L = typeof import("leaflet");
let leafletPromise: Promise<L> | null = null;
function loadLeaflet() {
  leafletPromise ??= Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([m]) => (m as unknown as { default: L }).default ?? (m as unknown as L));
  return leafletPromise;
}

export function MapView({ job, worker, onPick, className = "", zoom = 15 }: Props) {
  const cfg = useConfig();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const jobMarker = useRef<import("leaflet").Marker | null>(null);
  const workerMarker = useRef<import("leaflet").Marker | null>(null);
  const lib = useRef<L | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [ready, setReady] = useState(false);
  const fitted = useRef(false);

  useEffect(() => {
    if (!cfg || !el.current || map.current) return;
    let cancelled = false;
    void loadLeaflet().then((Lf) => {
      if (cancelled || !el.current) return;
      lib.current = Lf;
      const centre = job ?? cfg.centre;
      const m = Lf.map(el.current, { zoomControl: false, attributionControl: true }).setView([centre.lat, centre.lng], job ? zoom : 12);
      Lf.tileLayer(cfg.map.tiles, { maxZoom: 19, attribution: cfg.map.attribution }).addTo(m);
      Lf.control.zoom({ position: "bottomright" }).addTo(m);
      if (pick.current) m.on("click", (e) => pick.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
      map.current = m;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  useEffect(
    () => () => {
      map.current?.remove();
      map.current = null;
    },
    [],
  );

  // The job pin.
  useEffect(() => {
    const Lf = lib.current;
    const m = map.current;
    if (!ready || !Lf || !m) return;
    if (!job) {
      jobMarker.current?.remove();
      jobMarker.current = null;
      return;
    }
    const icon = Lf.divIcon({ className: "", html: '<div class="pin"></div>', iconSize: [34, 34], iconAnchor: [17, 34] });
    if (!jobMarker.current) {
      jobMarker.current = Lf.marker([job.lat, job.lng], { icon, draggable: Boolean(pick.current), keyboard: false }).addTo(m);
      jobMarker.current.on("dragend", () => {
        const p = jobMarker.current!.getLatLng();
        pick.current?.({ lat: p.lat, lng: p.lng });
      });
    } else jobMarker.current.setLatLng([job.lat, job.lng]);
    if (!worker) m.setView([job.lat, job.lng], Math.max(m.getZoom(), zoom - 1), { animate: true });
  }, [ready, job?.lat, job?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // The worker, and a view that shows both.
  useEffect(() => {
    const Lf = lib.current;
    const m = map.current;
    if (!ready || !Lf || !m) return;
    if (!worker) {
      workerMarker.current?.remove();
      workerMarker.current = null;
      return;
    }
    const icon = Lf.divIcon({ className: "", html: `<div class="worker-pin${worker.stale ? " stale" : ""}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    if (!workerMarker.current) workerMarker.current = Lf.marker([worker.lat, worker.lng], { icon, keyboard: false }).addTo(m);
    else {
      workerMarker.current.setLatLng([worker.lat, worker.lng]);
      workerMarker.current.setIcon(icon);
    }
    if (!fitted.current && job) {
      m.fitBounds(Lf.latLngBounds([[job.lat, job.lng], [worker.lat, worker.lng]]), { padding: [50, 50], maxZoom: 16 });
      fitted.current = true;
    }
  }, [ready, worker?.lat, worker?.lng, worker?.stale]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className={`map ${className}`} ref={el} role="img" aria-label="Map" />;
}
