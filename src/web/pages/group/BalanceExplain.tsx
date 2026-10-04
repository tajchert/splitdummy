import { Link, useSearchParams } from "react-router";
import { BackButton, useTitle } from "../../components/Shell";
import { Amount, Icon } from "../../components/ui";
import { fmtDay, fmtMoney } from "../../lib/format";
import { activeMembers, balanceOf, effectFor, nameOf } from "../../lib/project";
import { useView } from "../../state/project";
import { groupBase, sortEntries, Who } from "./parts";

export function BalanceExplain() {
  const view = useView();
  const [params, setParams] = useSearchParams();
  const who = params.get("member") ?? view.me.memberId;
  const isMe = who === view.me.memberId;
  const round = view.current;
  const b = balanceOf(round, who);
  const code = view.project.baseCurrency;
  const exp = view.project.baseExponent;
  const base = groupBase(view.project.id);
  const net = BigInt(b?.net ?? "0");
  const settling = round.round.status !== "COLLECTING";
  const name = nameOf(view, who);
  useTitle(isMe ? "Your balance" : `${name}'s balance`);
  const money = (v: bigint | string) => fmtMoney(v, code, exp);
  const abs = (v: bigint) => (v < 0n ? -v : v);

  const involved = sortEntries(round.entries)
    .map((e) => ({ e, fx: effectFor(e, who) }))
    .filter(({ fx }) => fx.paid !== 0n || fx.share !== 0n || fx.net !== 0n);
  const transfers = round.instructions.filter((i) => i.fromMemberId === who || i.toMemberId === who);

  return (
    <main id="main" className="page page-mid">
      <div className="page-top">
        <BackButton to={base} label="Back to group" />
      </div>
      <h1 className="page-h1">{isMe ? "How your balance works" : `How ${name}'s balance works`}</h1>
      <label className="field balance-who">
        <span className="field-label">Show balance for</span>
        <span className="select-wrap">
          <select className="input select" value={who} onChange={(e) => setParams(e.target.value === view.me.memberId ? {} : { member: e.target.value }, { replace: true })}>
            {activeMembers(view).map((m) => (
              <option key={m.id} value={m.id}>
                {nameOf(view, m.id, { you: true })}
              </option>
            ))}
          </select>
          <Icon name="expand_more" size={18} className="select-chevron" />
        </span>
      </label>

      <section className="card" aria-label="Breakdown">
        <dl className="ledger">
          <div>
            <dt>{isMe ? "You paid" : `${name} paid`}</dt>
            <dd>
              <Amount minor={b?.paid ?? "0"} code={code} exponent={exp} />
            </dd>
          </div>
          <div>
            <dt>{isMe ? "Your share of costs, after refunds" : "Share of costs, after refunds"}</dt>
            <dd>
              <Amount minor={-BigInt(b?.share ?? "0")} code={code} exponent={exp} />
            </dd>
          </div>
          {b && b.adjustments !== "0" && (
            <div>
              <dt>Corrections</dt>
              <dd>
                <Amount minor={b.adjustments} code={code} exponent={exp} signed />
              </dd>
            </div>
          )}
          <div className="ledger-total">
            <dt>{settling ? "Balance at freeze" : "Balance so far"}</dt>
            <dd>
              <Amount minor={net} code={code} exponent={exp} signed tone="auto" />
            </dd>
          </div>
        </dl>
        <p className="small">
          {net > 0n
            ? `The group owes ${isMe ? "you" : name} ${money(net)}.`
            : net < 0n
              ? `${isMe ? "You owe" : `${name} owes`} the group ${money(abs(net))}.`
              : `${isMe ? "You're" : `${name} is`} even: nothing to pay or receive.`}
          {!settling && " This can still change until the owner freezes the list."}
        </p>
      </section>

      {settling && b && (
        <section className="card" aria-labelledby="prog-h">
          <h2 id="prog-h" className="card-title">
            Repayment progress
          </h2>
          <dl className="ledger">
            <div>
              <dt>{net >= 0n ? "To receive" : "To pay"}</dt>
              <dd>
                <Amount minor={abs(net)} code={code} exponent={exp} />
              </dd>
            </div>
            <div>
              <dt>Confirmed so far</dt>
              <dd>
                <Amount minor={abs(BigInt(b.confirmedProgress ?? "0"))} code={code} exponent={exp} />
              </dd>
            </div>
            <div className="ledger-total">
              <dt>Remaining</dt>
              <dd>
                <Amount minor={abs(BigInt(b.remaining ?? "0"))} code={code} exponent={exp} />
              </dd>
            </div>
          </dl>
        </section>
      )}

      {transfers.length > 0 && (
        <section className="card" aria-labelledby="why-h">
          <h2 id="why-h" className="card-title">
            Why these people?
          </h2>
          <p className="small muted">
            {net < 0n
              ? `${isMe ? "You owe" : `${name} owes`} the group ${money(abs(net))}. To keep the number of transfers small, that amount is routed straight to people the group owes, instead of through everyone.`
              : `The group owes ${isMe ? "you" : name} ${money(net)}. People who owe the group pay ${isMe ? "you" : name} directly, so fewer transfers are needed.`}
          </p>
          <ul className="plain-list">
            {transfers.map((i) => (
              <li key={i.id} className="row-plain">
                <Icon name={i.fromMemberId === who ? "north_east" : "south_west"} size={18} className="muted" />
                <span className="grow">
                  <Who view={view} id={i.fromMemberId} you /> → <Who view={view} id={i.toMemberId} you />
                </span>
                <Amount minor={i.amount} code={i.currency} exponent={i.exponent} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack-12" aria-labelledby="inv-h">
        <div className="section-head">
          <h2 id="inv-h" className="section-title">
            Entries that count
          </h2>
          <span className="tiny muted">effect on balance</span>
        </div>
        {involved.length === 0 ? (
          <p className="small muted">{isMe ? "You're" : `${name} is`} not part of any entry yet.</p>
        ) : (
          <div className="card card-flush">
            {involved.map(({ e, fx }) => (
              <Link key={e.id} to={`${base}/e/${encodeURIComponent(e.id)}`} className="row explain-row">
                <div className="grow">
                  <div className="entry-title">{e.description}</div>
                  <div className="tiny muted">
                    {fmtDay(e.occurredAt, true)}
                    {fx.paid !== 0n && ` · ${e.type === "REFUND" ? "received" : "paid"} ${money(abs(fx.paid))}`}
                    {fx.share !== 0n && ` · share ${money(abs(fx.share))}`}
                    {e.type === "ADJUSTMENT" && " · correction"}
                  </div>
                </div>
                <Amount minor={fx.net} code={code} exponent={exp} signed tone="auto" />
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
