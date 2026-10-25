import { lazy, Suspense, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Empty, Skeleton } from "./components/ui";
import { LiveEvents, useAuth } from "./context/AuthContext";
import Home from "./pages/Home";

const Book = lazy(() => import("./pages/Book"));
const Login = lazy(() => import("./pages/Login"));
const Jobs = lazy(() => import("./pages/Jobs"));
const JobPage = lazy(() => import("./pages/JobPage"));
const Invoice = lazy(() => import("./pages/Invoice"));
const Account = lazy(() => import("./pages/Account"));
const Notifications = lazy(() => import("./pages/Notifications"));
const Legal = lazy(() => import("./pages/Legal"));
const Help = lazy(() => import("./pages/Help"));
const WorkHome = lazy(() => import("./pages/work/WorkHome"));
const Apply = lazy(() => import("./pages/work/Apply"));
const WorkJob = lazy(() => import("./pages/work/WorkJob"));
const Earnings = lazy(() => import("./pages/work/Earnings").then((m) => ({ default: m.Earnings })));
const WorkHistory = lazy(() => import("./pages/work/Earnings").then((m) => ({ default: m.WorkHistory })));
const Admin = lazy(() => import("./admin/Admin"));

const Loading = () => (
  <div style={{ padding: 16 }}>
    <Skeleton h={220} />
  </div>
);

function RequireSignIn({ children }: { children: ReactNode }) {
  const { me, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <>
      <LiveEvents />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/admin/*" element={<Admin />} />
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="book/:category" element={<Book />} />
            <Route path="login" element={<Login />} />
            <Route path="jobs" element={<RequireSignIn><Jobs /></RequireSignIn>} />
            <Route path="jobs/:id" element={<RequireSignIn><JobPage /></RequireSignIn>} />
            <Route path="invoice/:ref" element={<Invoice />} />
            <Route path="account" element={<Account />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="legal/:doc" element={<Legal />} />
            <Route path="help" element={<Help />} />
            <Route path="work" element={<WorkHome />} />
            <Route path="work/apply" element={<Apply />} />
            <Route path="work/jobs" element={<RequireSignIn><WorkHistory /></RequireSignIn>} />
            <Route path="work/jobs/:id" element={<RequireSignIn><WorkJob /></RequireSignIn>} />
            <Route path="work/earnings" element={<RequireSignIn><Earnings /></RequireSignIn>} />
            <Route
              path="*"
              element={
                <Empty icon={<span style={{ fontSize: 32 }}>404</span>} title="Page not found">
                  <Link to="/" className="link">
                    Go home
                  </Link>
                </Empty>
              }
            />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}
