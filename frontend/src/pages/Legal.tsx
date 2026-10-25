import { Navigate, useParams } from "react-router-dom";
import { PageHead } from "../components/ui";
import { useConfig } from "../context/AuthContext";
import { kes } from "../lib/format";
import type { Config } from "../types";

// Terms, privacy notice, and the fee, cancellation, refund and dispute policy shown at
// booking (PRD 11). The numbers come from the live settings, so they match what's charged.

const UPDATED = "25 October 2026";

export default function Legal() {
  const { doc } = useParams();
  const cfg = useConfig();
  if (doc !== "terms" && doc !== "privacy" && doc !== "policies") return <Navigate to="/legal/terms" replace />;
  const title = doc === "terms" ? "Terms of service" : doc === "privacy" ? "Privacy notice" : "Fees, cancellations and disputes";
  return (
    <div className="stack g-16">
      <PageHead title={title} back />
      <p className="small muted">Last updated {UPDATED}</p>
      {doc === "terms" && <Terms cfg={cfg} />}
      {doc === "privacy" && <Privacy cfg={cfg} />}
      {doc === "policies" && <Policies cfg={cfg} />}
    </div>
  );
}

const contact = (cfg?: Config) => [cfg?.support.phone && `call or text ${cfg.support.phone}`, cfg?.support.email && `email ${cfg.support.email}`].filter(Boolean).join(" or ") || "use Report a problem in the app";

function Terms({ cfg }: { cfg?: Config }) {
  const c = cfg?.fees.clientPct ?? 9;
  const w = cfg?.fees.workerPct ?? 9;
  return (
    <div className="prose">
      <p>Mjengo O'clock is a platform in Nairobi that connects people who need construction and household trade work ("clients") with plumbers, electricians, site managers and general workers ("workers"). By using it you agree to these terms.</p>
      <h2>Who does the work</h2>
      <p>Workers are independent professionals, not employees of Mjengo O'clock. They decide whether to accept a job and are responsible for doing it with reasonable skill and care, for their own tools, and for their own income tax. Before a worker can receive jobs we check their national ID and a selfie, and for electricians and plumbers a trade certificate or reference letter. We review ratings and suspend workers who fall below our standard.</p>
      <h2>Prices and fees</h2>
      <ul>
        <li>Each job shows its rate before you book: a fixed price, or an hourly rate times the hours you choose.</li>
        <li>We add a {c}% service fee to the job price, paid by the client, and deduct {w}% from the worker's share before payout. The same rates apply to every trade and job size, with no minimum fee.</li>
        <li>Example: on a KES 1,000 job the client pays KES {(1000 + Math.round(10 * c)).toLocaleString("en-KE")}, the worker receives KES {(1000 - Math.round(10 * w)).toLocaleString("en-KE")}, and Mjengo O'clock keeps KES {(Math.round(10 * c) + Math.round(10 * w)).toLocaleString("en-KE")} before its costs.</li>
        <li>Extra hours or materials are charged only if the client approves the request in the app. Anything not approved is not charged.</li>
        <li>Tips go to the worker in full.</li>
      </ul>
      <h2>Payment and escrow</h2>
      <p>Clients pay by M-Pesa when they confirm a booking. The money is held until the job is finished and the client approves it, raises a dispute, or {cfg?.policy.autoReleaseHours ?? 24} hours pass after completion without either, at which point it is released to the worker. Workers are paid only from money collected for their job; we do not pay workers from our own funds.</p>
      <h2>Cancellations, no-shows and disputes</h2>
      <p>These follow the fee, cancellation and dispute policy, which is part of these terms. The cancel screen always shows any fee before you confirm.</p>
      <h2>Conduct and safety</h2>
      <ul>
        <li>Treat each other with respect. Harassment, threats, discrimination or asking for payment outside the app can lead to suspension.</li>
        <li>Use Report a problem during a job if anything goes wrong. In an emergency call 999 or 112 first.</li>
        <li>Clients should make sure the site is safe and accessible at the booked time.</li>
      </ul>
      <h2>Liability</h2>
      <p>Workers are responsible for their work and for damage they cause. We help resolve problems through the dispute process and may refund some or all of a payment, but we do not guarantee any particular result and we are not liable for indirect losses. Nothing in these terms limits rights you have under the Consumer Protection Act.</p>
      <h2>Your account</h2>
      <p>You sign in with your phone number and a code we text you. Keep your phone secure. You can delete your account from the Account page at any time.</p>
      <h2>Changes and contact</h2>
      <p>We may update these terms and will tell you in the app before changes take effect. These terms are governed by the laws of Kenya. Questions: {contact(cfg)}.</p>
    </div>
  );
}

function Privacy({ cfg }: { cfg?: Config }) {
  return (
    <div className="prose">
      <p>This notice explains what personal data Mjengo O'clock collects, why, and your rights under Kenya's Data Protection Act, 2019.</p>
      <h2>What we collect</h2>
      <ul>
        <li><b>Everyone:</b> phone number, name, optional email, the addresses of your jobs and your primary location, your emergency contact, job photos you upload, messages in reports and disputes, ratings, and M-Pesa payment details (number, amount and receipt).</li>
        <li><b>Workers, in addition:</b> national ID number and photo, a selfie, trade certificates, payout details, and your device's location while you are available for jobs or on a job.</li>
      </ul>
      <h2>Why we use it</h2>
      <ul>
        <li>To match jobs with the nearest suitable worker, show progress and send SMS updates.</li>
        <li>To verify workers' identity and qualifications before they receive jobs.</li>
        <li>To take payments, hold them until the job is approved, pay workers and make refunds.</li>
        <li>To keep people safe, investigate reports and resolve disputes.</li>
        <li>To meet legal, tax and accounting obligations.</li>
      </ul>
      <h2>Location</h2>
      <p>We use a worker's location only with their consent, which they can turn off in Account at any time. A worker's live location is shown to a client only while that worker is on the way to, or at, the client's job. Clients' job addresses are shown to a worker in full only after they accept the job; before that they see the neighbourhood.</p>
      <h2>Who we share it with</h2>
      <ul>
        <li>The other person on your job: the client sees the worker's verified name, photo, rating and phone number during the job; the worker sees the client's first name, phone number during the job and the address.</li>
        <li>Service providers who act for us: Safaricom (M-Pesa payments and payouts), our SMS provider, our map and address-search provider, our hosting and database providers, and, when connected, an identity verification provider.</li>
        <li>Authorities, when the law requires it or to protect someone's safety.</li>
      </ul>
      <p>We do not sell personal data.</p>
      <h2>How long we keep it</h2>
      <p>Account data is kept while your account is open. ID documents are deleted when a worker account is deleted. Payment and job records are kept for as long as tax and accounting law requires, without your profile once you delete your account.</p>
      <h2>Your rights</h2>
      <p>You can ask to see, correct or delete your data, object to its use, or withdraw consent for location sharing. Most of this is in the Account page; for anything else, {contact(cfg)}. You can also complain to the Office of the Data Protection Commissioner.</p>
      <h2>Security</h2>
      <p>All traffic is encrypted, ID numbers are encrypted at rest, photos are served only through short-lived private links, and access to the database is restricted.</p>
    </div>
  );
}

function Policies({ cfg }: { cfg?: Config }) {
  const p = cfg?.policy;
  const rows: [string, string][] = [
    ["You cancel before a worker accepts", "Free. Your payment is refunded in full."],
    ["You cancel after a worker accepts, before they set off", `Free within ${p?.freeCancelMinutes ?? 5} minutes of booking; after that a ${kes(p?.lateCancelFee ?? 200)} fee goes to the worker.`],
    ["You cancel after the worker is on the way", `A ${kes(p?.enRouteCancelFee ?? 500)} cancellation fee goes to the worker.`],
    ["The worker cancels after accepting", "No fee to you. We find another worker; repeated cancellations count against the worker's standing."],
    ["The worker isn't on site 30 minutes after the expected time", `You can cancel free and are refunded in full. Our team is told and the worker is flagged.`],
    ["You're not there, or the site is inaccessible", `The worker waits ${p?.clientWaitMinutes ?? 15} minutes, logs it, and earns a ${kes(p?.calloutFee ?? 500)} call-out fee. The rest is refunded.`],
    ["The job needs more time or materials", "The worker requests it in the app with the amount, reason and a photo. You approve and pay, or decline, before work continues. Unapproved extras are not charged."],
    ["You don't respond after completion", `Payment releases to the worker automatically ${p?.autoReleaseHours ?? 24} hours after the job is marked complete.`],
    ["You dispute the work", `Raise it within ${p?.disputeWindowHours ?? 24} hours of completion, with a reason and photos. Payment stays frozen while our team reviews the photos and timeline, then releases it in full, refunds you in full, or splits it. We aim to decide within 3 business days and text both of you.`],
    ["A payment fails after completion", "A worker is paid only for money actually collected for their job. Anything not collected is not paid out until it is."],
  ];
  return (
    <div className="prose">
      <p>
        Prices are shown before you book. We add a {cfg?.fees.clientPct ?? 9}% service fee for clients and deduct {cfg?.fees.workerPct ?? 9}% from workers' payouts. Your M-Pesa payment is held until the job is approved, and refunds go back to the M-Pesa number that paid.
      </p>
      <table className="policy-table">
        <thead>
          <tr>
            <th>Situation</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Cancellation and call-out fees are paid to the worker in full. Refunds are usually sent to M-Pesa within minutes; occasionally the finance team sends them by hand within one business day.</p>
    </div>
  );
}
