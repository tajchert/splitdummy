import { Link } from "react-router";
import { apiExamples } from "@shared/api-guide";
import { AppBar, useTitle } from "../components/Shell";
import { useToast } from "../components/Toast";

function Code({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  return <div className="api-code">
    <div className="api-code-head"><span className="tiny muted">{label}</span>
      <button type="button" className="btn btn-outline btn-sm" aria-label={`Copy ${label}`} onClick={async () => {
        try { await navigator.clipboard.writeText(text); toast("Example copied", "success"); }
        catch { toast("Select the example and copy it manually", "info"); }
      }}>Copy</button>
    </div>
    <pre tabIndex={0}><code>{text}</code></pre>
  </div>;
}

export function ApiDocs() {
  useTitle("API docs");
  const examples = apiExamples(window.location.origin);
  return <>
    <AppBar mobile />
    <main id="main" className="page api-docs">
      <h1 className="page-h1">API for scripts and AI tools</h1>
      <p className="lede muted">Read balances, add expenses, and work with your groups using a simple HTTP API.</p>
      <p className="api-doc-links"><a href="/api/openapi.json">OpenAPI schema</a><a href="/api/docs">Plain-text guide for AI tools</a></p>

      <section className="card">
        <h2 className="card-title">1. Create a key</h2>
        <p>Sign in with your email, open <Link to="/account">Account → API keys</Link>, and choose an access level.</p>
        <p><strong>Read only</strong> works for summaries, balances and exports. <strong>Read and write</strong> also lets scripts change your groups, subject to your group role.</p>
        <p className="small muted">Copy the key when it appears: it’s shown once. Keys expire after 90 days; revoke them anytime in Account.</p>
      </section>

      <section className="card">
        <h2 className="card-title">2. List your groups</h2>
        <p>Send your key in the <code>Authorization</code> header. Cookies and an <code>Origin</code> header are unnecessary.</p>
        <Code text={examples.list} label="curl: list groups" />
        <p className="small muted">The response is an array. Choose a group’s <code>id</code> for the next request.</p>
      </section>

      <section className="card">
        <h2 className="card-title">3. Read expenses and balances</h2>
        <Code text={examples.group} label="curl: read a group" />
        <p>The response includes <code>members</code>, <code>current.entries</code>, <code>current.balances</code> and settlement <code>current.instructions</code>.</p>
        <p>Use <code>current.round.id</code> for the current round, <code>me.memberId</code> for yourself and <code>members[].id</code> for participants. Positive <code>net</code> means receives; negative means owes.</p>
      </section>

      <section className="card">
        <h2 className="card-title">4. Add an expense</h2>
        <p>This Python example adds lunch paid by you and split equally between all active members. It uses the standard library and a read/write key.</p>
        <p>Set <code>SPLITDUMMY_PROJECT_ID</code> to the group you chose. Review the amount and participants before running.</p>
        <Code text={examples.python} label="Python: add an expense" />
      </section>

      <section className="card">
        <h2 className="card-title">A few rules</h2>
        <ul className="api-rules">
          <li><strong>Money is a string of minor units.</strong> <code>"1250"</code> is 12.50 PLN/EUR/USD, 1250 JPY or 1.250 KWD. Use the currency’s exponent; avoid floating-point amounts.</li>
          <li><strong>Dates:</strong> <code>occurredAt</code> uses <code>YYYY-MM-DD</code>; other timestamps use ISO 8601 UTC.</li>
          <li><strong>Retries:</strong> group mutations require a new UUID in <code>Idempotency-Key</code>. Reuse the same UUID and body when retrying the same action.</li>
          <li><strong>Edits:</strong> send the latest <code>expectedRevision</code> or <code>expectedVersion</code>. Refetch when a revision is stale.</li>
          <li><strong>Splits:</strong> <code>EQUAL</code> omits participant amounts. <code>EXACT</code> supplies amounts that add up to the total.</li>
          <li><strong>Currencies:</strong> <code>IDENTITY</code> is for the base currency. Foreign currencies need multi-currency enabled and a manual rate or actual base amount.</li>
          <li><strong>Rounds:</strong> add and edit expenses while <code>COLLECTING</code>. Payment actions record transfers made outside Splitdummy.</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card-title">Using an LLM or AI tool</h2>
        <p>Import the <a href="/api/openapi.json">endpoint schema</a> into a tool that supports OpenAPI and configure Bearer authentication with your key. Use the <a href="/api/docs">plain-text guide</a> for clients that need text instructions.</p>
        <p>Start with read-only access for summaries. For writes, have the tool fetch current IDs and confirm the expense, participants or payment action with you before submitting.</p>
        <p className="small muted">Keep keys in your tool’s secret configuration or environment, outside prompts and shared chats. Join groups and manage your account on the website; API keys cannot change account access or manage keys.</p>
      </section>

      <section className="card">
        <h2 className="card-title">When a request fails</h2>
        <p>Errors are JSON with <code>error.code</code>, <code>error.message</code>, and optional <code>field</code> or <code>details</code>.</p>
        <dl className="api-errors">
          <dt>401</dt><dd>Invalid, expired or revoked key.</dd><dt>403</dt><dd>Read-only key or insufficient group permissions.</dd>
          <dt>404</dt><dd>Unavailable group or you’re not a member.</dd><dt>409</dt><dd>Stale revision, frozen round, or a conflicting action. Refetch before deciding what to submit.</dd>
          <dt>422</dt><dd>Invalid input; check the indicated field.</dd><dt>429</dt><dd>Rate limited. Wait before retrying; keys share your account’s limits.</dd>
          <dt>500</dt><dd>Server error. Include the response’s <code>X-Request-Id</code> when reporting it.</dd>
        </dl>
      </section>
    </main>
  </>;
}
