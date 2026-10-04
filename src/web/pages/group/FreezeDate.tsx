import { useState, type FormEvent } from "react";
import type { ProjectViewDTO, RoundDTO } from "@shared/api";
import { useApi } from "../../api/context";
import { ApiError, errorMessage } from "../../api/errors";
import { useSubmit } from "../../api/idempotency";
import { ConfirmDialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";
import { Banner, Icon } from "../../components/ui";
import { fmtWeekday, todayYmd } from "../../lib/format";
import { useProject } from "../../state/project";

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Mon 20 Oct", or "today (Mon 20 Oct)". */
export function freezeDayLabel(r: RoundDTO): string | null {
  if (!r.scheduledFreezeDate) return null;
  const day = fmtWeekday(r.scheduledFreezeDate);
  return r.scheduledFreezeDate === todayYmd() ? `today (${day})` : day;
}

/** " (Europe/Lisbon time)" when the owner picked the date in another time zone than yours. */
export function zoneNote(r: RoundDTO): string {
  const tz = r.scheduledFreezeTimeZone;
  return tz && tz !== localTimeZone() ? ` (${tz.replace(/_/g, " ")} time)` : "";
}

export function freezeScheduleSentence(r: RoundDTO): string | null {
  const day = freezeDayLabel(r);
  return day ? `The list freezes automatically at the end of ${day}${zoneNote(r)}.` : null;
}

function useFreezeSchedule(view: ProjectViewDTO) {
  const api = useApi();
  const { refresh } = useProject();
  const toast = useToast();
  const sub = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const round = view.current.round;
  const save = async (date: string | null) => {
    setError(null);
    const body = { date, timeZone: localTimeZone() };
    try {
      await sub.run({ ...body, round: round.id }, (k) => api.setFreezeSchedule(view.project.id, round.id, body, { idempotencyKey: k }));
      await refresh();
      toast(date ? `Freeze date set: ${fmtWeekday(date)}` : "Freeze date removed", date ? "success" : "info");
      return true;
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.status === 409) void refresh();
      return false;
    }
  };
  return { save, pending: sub.pending, error, setError };
}

function DateInput({ id, value, onChange, invalid }: { id: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  return (
    <span className="input-with-icon">
      <Icon name="calendar_today" size={18} />
      <input
        id={id}
        type="date"
        className="input"
        min={todayYmd()}
        value={value}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}

/** Owner-only form: pick, change or remove the automatic freeze date of the collecting round. */
export function FreezeDateForm({ view }: { view: ProjectViewDTO }) {
  const round = view.current.round;
  const s = useFreezeSchedule(view);
  const [date, setDate] = useState(round.scheduledFreezeDate ?? "");
  const tooEarly = !!date && date < todayYmd();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!date || tooEarly) return;
    await s.save(date);
  };
  return (
    <form className="stack-8" onSubmit={submit} noValidate>
      <label htmlFor="freeze-date" className="field-label">
        Freeze automatically at the end of
      </label>
      <div className="inline-form">
        <span className="grow">
          <DateInput id="freeze-date" value={date} onChange={(v) => (setDate(v), s.setError(null))} invalid={tooEarly || !!s.error} />
        </span>
        <button type="submit" className="btn btn-secondary btn-md" disabled={s.pending || !date || tooEarly || date === round.scheduledFreezeDate}>
          Save
        </button>
      </div>
      <span id="freeze-date-hint" className="field-hint">
        Everyone sees the date. Members who haven't marked “done adding” by then are noted, like an early freeze.
      </span>
      {(tooEarly || s.error) && (
        <span className="field-error" role="alert">
          <Icon name="error" size={16} />
          {tooEarly ? "Pick today or a later date." : s.error}
        </span>
      )}
      {round.scheduledFreezeDate && (
        <button type="button" className="link-btn small danger-text align-start" disabled={s.pending} onClick={() => void s.save(null).then((ok) => ok && setDate(""))}>
          <Icon name="event_busy" size={16} />
          Remove the freeze date
        </button>
      )}
    </form>
  );
}

function FreezeDateDialog({ view, onClose }: { view: ProjectViewDTO; onClose: () => void }) {
  const round = view.current.round;
  const s = useFreezeSchedule(view);
  const [date, setDate] = useState(round.scheduledFreezeDate ?? "");
  const tooEarly = !!date && date < todayYmd();
  return (
    <ConfirmDialog
      title={round.scheduledFreezeDate ? "Change the freeze date" : "Set a freeze date"}
      confirmLabel="Save date"
      confirmIcon="event"
      pending={s.pending}
      onCancel={onClose}
      onConfirm={() => {
        if (!date) return s.setError("Pick a date.");
        if (tooEarly) return s.setError("Pick today or a later date.");
        void s.save(date).then((ok) => ok && onClose());
      }}
    >
      <p>The list freezes automatically at the end of the day you pick, even if not everyone has finished adding.</p>
      <label htmlFor="freeze-date-d" className="field-label ink">
        Date
      </label>
      <DateInput id="freeze-date-d" value={date} onChange={(v) => (setDate(v), s.setError(null))} invalid={!!s.error} />
      <span id="freeze-date-d-hint" className="sr-only">
        Today or later
      </span>
      {s.error && (
        <span className="field-error" role="alert">
          <Icon name="error" size={16} />
          {s.error}
        </span>
      )}
      {round.scheduledFreezeDate && (
        <button type="button" className="link-btn small danger-text align-start" disabled={s.pending} onClick={() => void s.save(null).then((ok) => ok && onClose())}>
          <Icon name="event_busy" size={16} />
          Remove the freeze date
        </button>
      )}
    </ConfirmDialog>
  );
}

/** Collecting screen: the freeze date for everyone; the owner can set or change it here. */
export function FreezeDateNotice({ view }: { view: ProjectViewDTO }) {
  const round = view.current.round;
  const [editing, setEditing] = useState(false);
  const owner = view.me.isOwner;
  if (round.status !== "COLLECTING") return null;
  const day = freezeDayLabel(round);
  const dialog = editing && <FreezeDateDialog view={view} onClose={() => setEditing(false)} />;
  if (!day) {
    if (!owner) return null;
    return (
      <>
      <div className="freeze-date-empty">
        <Icon name="event" size={18} className="muted" />
        <span className="grow small muted">No freeze date yet. Pick one so everyone knows when to finish adding.</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
          Set date
        </button>
      </div>
      {dialog}
      </>
    );
  }
  return (
    <>
      <Banner
        tone="blue"
        icon="event"
        action={
          owner && (
            <button type="button" className="btn btn-sm btn-ink" onClick={() => setEditing(true)}>
              Change
            </button>
          )
        }
      >
        Add your expenses by <span className="nowrap">{day}</span>
        <p>The list freezes automatically at the end of that day{zoneNote(round)}.</p>
      </Banner>
      {dialog}
    </>
  );
}
