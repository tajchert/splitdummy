import { useSyncExternalStore } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let state: { prompt: InstallPrompt | null; installed: boolean } = { prompt: null, installed: false };
const subscribers = new Set<() => void>();
function update(next: typeof state) {
  state = next;
  subscribers.forEach((notify) => notify());
}

// Listen at startup: the browser may offer installation before Account is loaded.
export function listenForInstall() {
  update({ prompt: null, installed: false });
  const onPrompt = (event: Event) => {
    event.preventDefault();
    update({ prompt: event as InstallPrompt, installed: false });
  };
  const onInstalled = () => update({ prompt: null, installed: true });
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

export function useInstall() {
  return useSyncExternalStore(
    (notify) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
    () => state,
  );
}

export async function installApp() {
  const prompt = state.prompt;
  if (!prompt) return;
  // Each browser event can be used only once, including when dismissed.
  update({ ...state, prompt: null });
  await prompt.prompt();
  await prompt.userChoice;
}
