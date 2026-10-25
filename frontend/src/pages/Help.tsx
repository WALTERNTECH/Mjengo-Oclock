import { Link } from "react-router-dom";
import { ReportProblem } from "../components/ReportProblem";
import { PageHead } from "../components/ui";
import { useAuth, useConfig } from "../context/AuthContext";

export default function Help() {
  const cfg = useConfig();
  const { me } = useAuth();
  return (
    <div className="stack g-16">
      <PageHead title="Help and safety" back />
      <div className="prose">
        <h2>In an emergency</h2>
        <p>
          Call <a href="tel:999">999</a> or <a href="tel:112">112</a> first. Then use Report a problem on the job screen and choose Emergency: our team is alerted straight away and, if you've added one, your emergency contact gets a text with where you are.
        </p>
        <h2>Before the worker arrives</h2>
        <ul>
          <li>Check the name, photo and rating on the job screen match the person who arrives.</li>
          <li>Pay only through the app. Workers are never asked to collect cash for the job.</li>
          <li>Extra work or materials must be requested in the app and approved by you before they're done.</li>
        </ul>
        <h2>For workers</h2>
        <ul>
          <li>Keep the Mjengo O'clock screen open while you're on a job; phones, especially iPhones, may stop sharing location when the app is in the background. Your status buttons still send the client's SMS updates.</li>
          <li>If the client isn't there, wait on site for {cfg?.policy.clientWaitMinutes ?? 15} minutes, then log it from the job screen to receive the call-out fee.</li>
        </ul>
        <h2>Questions</h2>
        <p>
          {cfg?.support.phone || cfg?.support.email ? (
            <>
              Contact us {cfg.support.phone && <>on <a href={`tel:${cfg.support.phone}`}>{cfg.support.phone}</a></>}
              {cfg.support.phone && cfg.support.email && " or "}
              {cfg.support.email && <a href={`mailto:${cfg.support.email}`}>{cfg.support.email}</a>}.
            </>
          ) : (
            "Use Report a problem below and our team will get back to you."
          )}{" "}
          See also the <Link to="/legal/policies">fees, cancellation and dispute policy</Link>.
        </p>
      </div>
      {me ? <ReportProblem block /> : <Link to="/login?next=/help" className="btn btn-block">Sign in to report a problem</Link>}
    </div>
  );
}
