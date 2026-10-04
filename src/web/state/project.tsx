import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectViewDTO } from "@shared/api";
import { useApi } from "../api/context";
import type { ApiError } from "../api/errors";
import type { LiveStatus } from "../api/types";

export interface ProjectState {
  projectId: string;
  view: ProjectViewDTO | null;
  error: ApiError | null;
  live: LiveStatus;
  /** Refetch now; resolves with the fresh view. */
  refresh: () => Promise<ProjectViewDTO | null>;
  /** Increments on every live change notification; screens like Review watch it. */
  changeTick: number;
}

const ProjectContext = createContext<ProjectState | null>(null);

export function useProject(): ProjectState {
  const p = useContext(ProjectContext);
  if (!p) throw new Error("useProject outside ProjectProvider");
  return p;
}

/** Loaded view or throw — for components rendered only after the layout has data. */
export function useView(): ProjectViewDTO {
  const { view } = useProject();
  if (!view) throw new Error("project view not loaded");
  return view;
}

export function ProjectProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const api = useApi();
  const [view, setView] = useState<ProjectViewDTO | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const [changeTick, setChangeTick] = useState(0);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const v = await api.getProject(projectId);
      // Drop responses that a later refetch has overtaken.
      if (mine === seq.current) {
        setView(v);
        setError(null);
      }
      return v;
    } catch (e) {
      if (mine === seq.current) setError(e as ApiError);
      return null;
    }
  }, [api, projectId]);

  useEffect(() => {
    setView(null);
    setError(null);
    void refresh();
    const sub = api.live(projectId, {
      onChange: () => {
        setChangeTick((t) => t + 1);
        void refresh();
      },
      onStatus: setLive,
    });
    return () => sub.close();
  }, [api, projectId, refresh]);

  const value = useMemo(
    () => ({ projectId, view, error, live, refresh, changeTick }),
    [projectId, view, error, live, refresh, changeTick],
  );
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}
