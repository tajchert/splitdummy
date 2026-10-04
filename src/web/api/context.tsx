import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConfigDTO, MeDTO } from "@shared/api";
import type { Api } from "./types";

const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi outside ApiProvider");
  return api;
}

interface SessionState {
  me: MeDTO | null;
  /** undefined while the first /api/me is in flight. */
  loaded: boolean;
  config: ConfigDTO | null;
  refresh: () => Promise<MeDTO | null>;
  setMe: (me: MeDTO | null) => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside ApiProvider");
  return s;
}

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<ConfigDTO | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await api.getMe();
      setMe(m);
      return m;
    } catch {
      return null;
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    api.getConfig().then(setConfig, () => setConfig({ turnstileSiteKey: null, environment: "production" }));
  }, [api, refresh]);

  const session = useMemo(() => ({ me, loaded, config, refresh, setMe }), [me, loaded, config, refresh]);

  return (
    <ApiContext.Provider value={api}>
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
    </ApiContext.Provider>
  );
}
