export type ThemePref = "system" | "light" | "dark";
const KEY = "splitdummy-theme";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function setThemePref(p: ThemePref): void {
  try {
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* storage blocked: still apply for this page view */
  }
  apply(p);
}

function apply(p: ThemePref) {
  const root = document.documentElement;
  if (p === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p);
}

export function applyStoredTheme(): void {
  // ?theme=dark|light is handy for screenshots and support links.
  const q = new URLSearchParams(location.search).get("theme");
  if (q === "dark" || q === "light") return apply(q);
  apply(getThemePref());
}
