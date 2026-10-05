import { useId, type ReactNode, type SelectHTMLAttributes } from "react";
import { COMMON_CURRENCIES, CURRENCIES } from "@shared/money";
import { currencyName } from "../lib/format";
import { Icon } from "./ui";

/** Label + control + hint + error, wired with aria-describedby / aria-invalid. */
export function Field({ label, hint, error, children, className }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field${error ? " field-invalid" : ""}${className ? " " + className : ""}`}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error && (
        <span id={errId} className="field-error">
          <Icon name="error" size={16} />
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Common currencies first, then the full ISO list; codes with localized names. */
export function CurrencySelect({ value, onChange, id, compact, exclude, ...aria }: {
  value: string;
  onChange: (code: string) => void;
  id?: string;
  compact?: boolean;
  exclude?: string[];
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-label"?: string;
}) {
  const common = COMMON_CURRENCIES.filter((c) => !exclude?.includes(c));
  const rest = [...CURRENCIES].filter((c) => !COMMON_CURRENCIES.includes(c.code) && !exclude?.includes(c.code)).sort((a, b) => a.code.localeCompare(b.code));
  return (
    <Select wrapClassName={compact ? "select-compact" : undefined} id={id} value={value} onChange={(e) => onChange(e.target.value)} {...aria}>
        <optgroup label="Common">
          {common.map((c) => (
            <option key={c} value={c}>
              {compact ? c : `${c} · ${currencyName(c)}`}
            </option>
          ))}
        </optgroup>
        <optgroup label="All currencies">
          {rest.map((c) => (
            <option key={c.code} value={c.code}>
              {compact ? c.code : `${c.code} · ${currencyName(c.code)}`}
            </option>
          ))}
        </optgroup>
    </Select>
  );
}

/** The app's dropdown: a native <select> styled like an input, with our chevron. Every select renders through this. */
export function Select({ wrapClassName, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { wrapClassName?: string }) {
  return (
    <span className={`select-wrap${wrapClassName ? " " + wrapClassName : ""}`}>
      <select {...rest} className={`input select${className ? " " + className : ""}`}>
        {children}
      </select>
      <Icon name="expand_more" size={18} className="select-chevron" />
    </span>
  );
}

export function Toggle({ checked, onChange, label, description, disabled, id }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  const gen = useId();
  const tid = id ?? gen;
  return (
    <div className={`toggle-row${disabled ? " is-disabled" : ""}`}>
      <div className="toggle-text">
        <label htmlFor={tid} className="toggle-label">
          {label}
        </label>
        {description && (
          <span className="toggle-desc" id={`${tid}-d`}>
            {description}
          </span>
        )}
      </div>
      <input
        id={tid}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${tid}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}
