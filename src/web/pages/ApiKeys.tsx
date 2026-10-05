import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { ApiKeyDTO } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { errorMessage } from "../api/errors";
import { Field } from "../components/Field";
import { Banner, Loading } from "../components/ui";
import { useToast } from "../components/Toast";

export function ApiKeys() {
  const api = useApi();
  const { me } = useSession();
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"READ" | "WRITE">("READ");
  const [secret, setSecret] = useState<{ id: string; token: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = me?.kind === "ACCOUNT";

  useEffect(() => {
    if (!account) return;
    let active = true;
    setLoaded(false);
    void api.listApiKeys().then((result) => {
      if (active) {
        setKeys(result);
        setSecret((current) => current && result.some((key) => key.id === current.id) ? current : null);
        setLoaded(true);
      }
    }).catch((err: unknown) => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, [api, account, refresh]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || secret) return;
    setPending(true);
    setError(null);
    try {
      const { token, ...key } = await api.createApiKey({ name: name.trim(), scope });
      setKeys((current) => [key, ...current]);
      setSecret({ id: key.id, token });
      setName("");
    } catch (err) {
      setError(errorMessage(err));
      // A lost response may still have created a key. Refresh metadata so it can be revoked.
      setRefresh((value) => value + 1);
    } finally { setPending(false); }
  };
  const revoke = async (key: ApiKeyDTO) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await api.revokeApiKey(key.id);
      setKeys((current) => current.filter((item) => item.id !== key.id));
      if (secret?.id === key.id) setSecret(null);
      toast("API key revoked", "info");
    } catch (err) {
      setError(errorMessage(err));
      setRefresh((value) => value + 1);
    }
    finally { setPending(false); }
  };

  return (
    <section className="card" aria-labelledby="acc-api-keys">
      <h2 id="acc-api-keys" className="card-title">API keys</h2>
      <p className="small muted">Use your groups from scripts and AI tools. <Link to="/docs/api">Read the API docs</Link>.</p>
      {!account ? <p className="small">Sign in with your email to create an API key.</p> : <>
        {error && <Banner tone="red" role="alert">{error}</Banner>}
        {!loaded && !error && <Loading />}
        {!loaded && error && <button className="btn btn-outline" type="button" onClick={() => { setError(null); setRefresh((value) => value + 1); }}>Retry loading keys</button>}
        {secret && <div className="api-key-secret" role="status">
          <p><strong>Save your key now.</strong> You won’t be able to see it again.</p>
          <Field label="New API key">{(props) => <input {...props} className="input api-key-token" readOnly value={secret.token} autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} />}</Field>
          <div className="api-key-actions">
            <button type="button" className="btn btn-primary" onClick={async () => {
              try { await navigator.clipboard.writeText(secret.token); toast("API key copied", "success"); }
              catch { toast("Select the key and copy it manually", "info"); }
            }}>Copy key</button>
            <button type="button" className="btn btn-outline" onClick={() => setSecret(null)}>Done, I saved it</button>
          </div>
        </div>}
        {loaded && !secret && <form onSubmit={create} className="api-key-form">
          <Field label="Key name">{(props) => <input {...props} className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder="My script" />}</Field>
          <Field label="Access" hint="Read/write keys can change your groups, subject to your group role.">{(props) => <select {...props} className="input select" value={scope} onChange={(event) => setScope(event.target.value as "READ" | "WRITE")}>
            <option value="READ">Read only</option><option value="WRITE">Read and write</option>
          </select>}</Field>
          <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()}>Create API key</button>
          <p className="tiny muted">Keys expire after 90 days. Keep them private; revoke any key you no longer use.</p>
        </form>}
        {keys.length > 0 && <ul className="api-key-list">{keys.map((key) => <li key={key.id}>
          <div className="api-key-info"><strong>{key.name}</strong><span className="tiny muted">{key.prefix}… · {key.scope === "READ" ? "Read only" : "Read/write"}<br />
            {Date.parse(key.expiresAt) <= Date.now() ? "Expired" : "Expires"} {new Date(key.expiresAt).toLocaleDateString()}</span></div>
          <button type="button" className="btn btn-outline btn-sm" disabled={pending || !loaded} aria-label={`Revoke ${key.name}`} onClick={() => void revoke(key)}>Revoke</button>
        </li>)}</ul>}
        {loaded && keys.length === 0 && <p className="tiny muted">No API keys yet.</p>}
      </>}
    </section>
  );
}
