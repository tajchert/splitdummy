import { Link } from "react-router";
import { AppBar, useTitle } from "../components/Shell";

const CONTACT = "privacy@splitdummy.app";

/** Policy of the hosted instance (splitdummy.app). Self-hosters: replace this page with your own. */
export function Privacy() {
  useTitle("Privacy");
  return <>
    <AppBar mobile />
    <main id="main" className="page privacy">
      <h1 className="page-h1">Privacy</h1>
      <p className="lede muted">
        This covers splitdummy.app, run by Michal Tajchert. Contact: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        Self-hosted copies of Splitdummy are run by someone else, who is responsible for your data there.
      </p>

      <section className="card">
        <h2 className="card-title">What we keep</h2>
        <ul>
          <li>Your email, if you sign in with one, and your display name.</li>
          <li>What you add to groups: names, members, expenses and payments. Members of a group can see it.</li>
          <li>Your browser keeps a sign-in cookie, your theme and unsent drafts. No tracking cookies, no ads, nothing sold.</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">Analytics and logs</h2>
        <ul>
          <li>Cloudflare Web Analytics counts page views and load times, without cookies or profiles.</li>
          <li>We count which features are used, how often and how fast, with no user identifiers.</li>
          <li>Server logs and crash reports help us fix problems. They can include your IP address and are deleted after 7 days.</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">Who processes it</h2>
        <p>
          Cloudflare hosts the app and its data, keeps daily backups, sends our emails and checks for bots at sign-in. Google Fonts serves the fonts,
          so your browser connects to Google. Both may process data outside the EU under the EU–US Data Privacy Framework.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">How long, and your rights</h2>
        <p>
          We keep your data while your account or group exists. Deleting your account in <Link to="/account">Account</Link> removes your email and name,
          deletes the groups you own with their backups, and anonymizes you in other groups. Backups of a group are kept until the group is deleted.
        </p>
        <p>
          We rely on providing the service you asked for (GDPR Art. 6(1)(b)) and on our legitimate interest in keeping it secure and working (Art. 6(1)(f)).
          Write to <a href={`mailto:${CONTACT}`}>{CONTACT}</a> to access, correct, export or delete your data, or to object.
          You can also complain to a data protection authority (in Poland: UODO).
        </p>
      </section>

      <p className="small muted">Updated 5 October 2026.</p>
    </main>
  </>;
}
