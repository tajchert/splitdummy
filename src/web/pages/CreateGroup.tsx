import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { CreateProjectSchema } from "@shared/api";
import { useApi, useSession } from "../api/context";
import { ApiError, errorMessage, fieldErrors } from "../api/errors";
import { useSubmit } from "../api/idempotency";
import { CurrencySelect, Field, Toggle } from "../components/Field";
import { AppBar, RequireSession, useTitle } from "../components/Shell";
import { useToast } from "../components/Toast";
import { Turnstile, useTurnstileRequired, type TurnstileHandle } from "../components/Turnstile";
import { Icon } from "../components/ui";
import { currencyName } from "../lib/format";

function guessCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    const map: Record<string, string> = { US: "USD", GB: "GBP", PL: "PLN", CH: "CHF", JP: "JPY", CA: "CAD", AU: "AUD", SE: "SEK", NO: "NOK", DK: "DKK", CZ: "CZK" };
    const euro = ["DE", "FR", "ES", "IT", "PT", "NL", "BE", "AT", "IE", "FI", "GR", "SK", "SI", "LT", "LV", "EE", "LU", "MT", "CY", "HR"];
    if (region && map[region]) return map[region];
    if (region && euro.includes(region)) return "EUR";
  } catch {
    /* ignore */
  }
  return "EUR";
}

export function CreateGroup() {
  useTitle("Create a group");
  return (
    <RequireSession account>
      <CreateGroupInner />
    </RequireSession>
  );
}

function CreateGroupInner() {
  const api = useApi();
  const { me } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, pending } = useSubmit();
  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState(me?.displayName ?? "");
  const [currency, setCurrency] = useState(guessCurrency);
  const [multi, setMulti] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [token, setToken] = useState<string | null>(null);
  const ts = useRef<TurnstileHandle>(null);
  // The server skips Turnstile for signed-in accounts; only guests with an email need it here.
  const isAccount = me?.kind === "ACCOUNT";
  const needsToken = useTurnstileRequired() && !isAccount;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateProjectSchema.safeParse({ name, baseCurrency: currency, multiCurrencyEnabled: multi, ownerDisplayName: ownerName });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
      setErrors(errs);
      return;
    }
    if (needsToken && !token) {
      setErrors({ _form: "Complete the check above the button first." });
      return;
    }
    const body = { ...parsed.data, ...(token ? { turnstileToken: token } : {}) };
    try {
      const view = await run(parsed.data, (k) => api.createProject(body, { idempotencyKey: k }));
      toast("Group created");
      navigate(`/g/${encodeURIComponent(view.project.id)}`, { replace: true, state: { justCreated: true } });
    } catch (err) {
      if (err instanceof ApiError && err.code === "TURNSTILE_FAILED") ts.current?.reset();
      if (err instanceof ApiError && (err.status === 401 || err.details?.reason === "ACCOUNT_REQUIRED")) {
        navigate(`/signin?next=%2Fgroups%2Fnew&reason=account`);
        return;
      }
      setErrors(err instanceof ApiError ? fieldErrors(err) : { _form: errorMessage(err) });
    }
  };

  return (
    <>
      <AppBar crumbs={<b>Create a group</b>} />
      <main id="main" className="page page-narrow">
        <div className="page-head page-head-close">
          <h1 className="page-h1">Create a group</h1>
          <Link to="/groups" className="round-btn" aria-label="Close">
            <Icon name="close" size={20} />
          </Link>
        </div>
        <form className="stack-16" onSubmit={onSubmit} noValidate>
          <Field label="Group name" error={errors.name} hint="For example: Lisbon trip, Flat bills, Anna's birthday.">
            {(p) => (
              <input {...p} className="input" value={name} maxLength={80} autoFocus onChange={(e) => (setName(e.target.value), setErrors((x) => ({ ...x, name: "" })))} />
            )}
          </Field>
          <Field label="Your name in this group" error={errors.ownerDisplayName} hint="Shown to the people you invite.">
            {(p) => (
              <input
                {...p}
                className="input"
                value={ownerName}
                maxLength={40}
                autoComplete="given-name"
                onChange={(e) => (setOwnerName(e.target.value), setErrors((x) => ({ ...x, ownerDisplayName: "" })))}
              />
            )}
          </Field>
          <Field
            label="Settlement currency"
            error={errors.baseCurrency}
            hint={`Everyone repays in ${currency} (${currencyName(currency)}). It can't change after the first expense.`}
          >
            {(p) => <CurrencySelect {...p} value={currency} onChange={setCurrency} />}
          </Field>
          <div className="card">
            <Toggle
              checked={multi}
              onChange={setMulti}
              label="Allow expenses in other currencies"
              description={`Expenses can use different currencies, each with its own saved exchange rate. Everyone settles in ${currency}.`}
            />
          </div>
          {!isAccount && <Turnstile ref={ts} onToken={setToken} action="create_project" />}
          {errors._form && (
            <div className="form-error" role="alert">
              <Icon name="error" size={18} />
              {errors._form}
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
            {pending ? "Creating…" : "Create group"}
          </button>
        </form>
      </main>
    </>
  );
}
