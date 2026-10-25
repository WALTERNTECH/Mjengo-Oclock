import { Bell, MessageSquareOff } from "lucide-react";
import { useEffect } from "react";
import { Link, Navigate } from "react-router-dom";
import { api, useApi } from "../api/client";
import { Empty, PageHead, Skeleton } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { ago } from "../lib/format";
import type { Notification } from "../types";

export default function Notifications() {
  const { me, ready, refresh } = useAuth();
  const { data, loading } = useApi<{ notifications: Notification[] }>(me ? "/notifications" : null, { staleMs: 5_000 });
  useEffect(() => {
    if (!data?.notifications.some((n) => !n.read_at)) return;
    const t = setTimeout(() => void api.post("/notifications/read", {}).then(() => refresh()), 1500);
    return () => clearTimeout(t);
  }, [data, refresh]);
  if (ready && !me) return <Navigate to="/login?next=/notifications" replace />;
  return (
    <div className="stack g-16">
      <PageHead title="Notifications" back />
      {loading && <Skeleton h={200} />}
      {data && !data.notifications.length && <Empty icon={<Bell />} title="Nothing yet" />}
      <div className="list">
        {data?.notifications.map((n) => {
          const body = (
            <>
              <div className="grow stack g-4">
                <span className="notif-title strong">{n.title}</span>
                {n.body && <span className="small muted">{n.body}</span>}
                {n.sms_status === "failed" && (
                  <span className="tiny red row g-4">
                    <MessageSquareOff size={13} /> We couldn't deliver this by SMS, so it's here instead.
                  </span>
                )}
              </div>
              <span className="tiny faint nowrap">{ago(n.created_at)}</span>
            </>
          );
          return n.link ? (
            <Link key={n.id} to={n.link} className={`notif ${n.read_at ? "" : "unread"}`}>
              {body}
            </Link>
          ) : (
            <div key={n.id} className={`notif ${n.read_at ? "" : "unread"}`}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
