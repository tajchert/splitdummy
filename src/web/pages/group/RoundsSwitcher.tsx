import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { ProjectViewDTO, RoundDTO, RoundViewDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { StatusPill } from "../../components/ui";
import { fmtDate, fmtMoney, fmtShortDate, plural } from "../../lib/format";
import { confirmedCount, roundLabel } from "../../lib/project";
import { groupBase } from "./parts";

/** Previous rounds are settled before a new one starts, so their views never change: cache them for the session. */
const cache = new Map<string, RoundViewDTO>();
const MAX_PREVIOUS = 5;

function usePreviousRoundViews(view: ProjectViewDTO, rounds: RoundDTO[]): Record<string, RoundViewDTO> {
  const api = useApi();
  const key = (id: string) => `${view.project.id}:${id}`;
  const [views, setViews] = useState<Record<string, RoundViewDTO>>(() =>
    Object.fromEntries(rounds.flatMap((r) => (cache.has(key(r.id)) ? [[r.id, cache.get(key(r.id))!]] : []))),
  );
  const ids = rounds.map((r) => `${r.id}:${r.status}`).join();
  useEffect(() => {
    let live = true;
    for (const r of rounds) {
      const hit = cache.get(key(r.id));
      if (hit && hit.round.status === r.status) {
        setViews((v) => (v[r.id] === hit ? v : { ...v, [r.id]: hit }));
        continue;
      }
      api.getRound(view.project.id, r.id).then(
        (rv) => {
          cache.set(key(r.id), rv);
          if (live) setViews((v) => ({ ...v, [r.id]: rv }));
        },
        () => {
          /* the brief is optional; the link still works */
        },
      );
    }
    return () => {
      live = false;
    };
  }, [api, view.project.id, ids]);
  return views;
}

function dateLine(r: RoundDTO, short: boolean): string {
  const f = short ? fmtShortDate : fmtDate;
  if (r.settledAt) return `Settled ${f(r.settledAt)}`;
  if (r.frozenAt) return `Frozen ${f(r.frozenAt)}`;
  return `Started ${f(r.createdAt)}`;
}

/** [total spent, transfer progress] for one round. */
function brief(view: ProjectViewDTO, rv: RoundViewDTO | undefined): [string, string] | null {
  if (!rv) return null;
  const spent = `${fmtMoney(rv.totals.expenses, view.project.baseCurrency, view.project.baseExponent)} spent`;
  const n = rv.instructions.length;
  const r = rv.round;
  if (r.status === "COLLECTING") return [spent, plural(rv.entries.length, "entry", "entries")];
  if (r.status === "SETTLING") return [spent, `${confirmedCount(rv)} of ${plural(n, "transfer", "transfers")} confirmed`];
  return [spent, n === 0 ? "No repayments needed" : `${plural(n, "transfer", "transfers")} · All settled`];
}

/**
 * Switch between the current round and previous ones (read-only pages). Shown only once a group
 * has more than one round: a horizontal chip row on phones, a list card in the desktop side panel.
 * `viewingId` marks the round on screen; the latest round is always tagged "Current".
 */
export function RoundsSwitcher({ view, viewingId, chipsOnly }: { view: ProjectViewDTO; viewingId?: string; chipsOnly?: boolean }) {
  const base = groupBase(view.project.id);
  const current = view.current.round;
  const viewing = viewingId ?? current.id;
  const previous = view.rounds.filter((r) => r.id !== current.id).sort((a, b) => b.sequence - a.sequence);
  const shown = previous.slice(0, MAX_PREVIOUS);
  const views = usePreviousRoundViews(view, shown);
  if (previous.length === 0) return null;

  const items = [{ r: current, rv: view.current as RoundViewDTO | undefined }, ...shown.map((r) => ({ r, rv: views[r.id] }))];
  const to = (r: RoundDTO) => (r.id === current.id ? base : `${base}/rounds/${encodeURIComponent(r.id)}`);
  const more = previous.length > shown.length;

  return (
    <section className={`rounds-switch${chipsOnly ? " rounds-switch-chips" : ""}`} aria-labelledby="rounds-h">
      <div className="card rounds-card">
        <div className="card-head rounds-head">
          <h2 id="rounds-h" className="card-title">
            Rounds
          </h2>
          <Link to={`${base}/history`} className="link-btn small">
            {more ? `All ${view.rounds.length}` : "History"}
          </Link>
        </div>
        <ul className="round-list rounds-desktop">
          {items.map(({ r, rv }) => (
            <li key={r.id}>
              <Link to={to(r)} className="round-item" aria-current={r.id === viewing ? "page" : undefined}>
                <span className={`round-num round-num-sm${r.id === current.id ? " is-current" : ""}`} aria-hidden="true">
                  {r.sequence}
                </span>
                <span className="round-item-main">
                  <span className="round-item-title">
                    {roundLabel(r.sequence)}
                    {r.id === current.id && <span className="tag tag-current">Current</span>}
                    <StatusPill status={r.status} small />
                  </span>
                  <span className="round-item-sub">{dateLine(r, false)}</span>
                  {rv && <span className="round-item-sub">{brief(view, rv)!.join(" · ")}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <ul className="round-chips rounds-mobile" aria-label="Rounds">
        {items.map(({ r, rv }) => (
          <li key={r.id}>
            <Link to={to(r)} className="round-chip" aria-current={r.id === viewing ? "page" : undefined}>
              <span className="round-chip-title">
                {roundLabel(r.sequence)}
                {r.id === current.id && <span className="tag tag-current">Current</span>}
              </span>
              <StatusPill status={r.status} small />
              <span className="round-item-sub">{dateLine(r, true)}</span>
              {rv && (
                <span className="round-item-sub">
                  <b className="ink">{brief(view, rv)![0]}</b>
                  <br />
                  {brief(view, rv)![1]}
                </span>
              )}
            </Link>
          </li>
        ))}
        {more && (
          <li>
            <Link to={`${base}/history`} className="round-chip round-chip-more">
              All {view.rounds.length} rounds
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}
