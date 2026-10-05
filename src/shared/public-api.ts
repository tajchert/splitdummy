import { ENDPOINTS } from "./api";

/** Explicit public surface: group operations and identity lookup, never account/auth/key management. */
export const PUBLIC_API_ENDPOINTS = Object.fromEntries(Object.entries(ENDPOINTS).filter(([key, endpoint]) =>
  key === "me" || key === "listProjects" || key === "createProject" ||
  (endpoint.split(" ")[1]?.startsWith("/api/projects/") && key !== "live"),
)) as Partial<typeof ENDPOINTS>;

const routes = Object.values(PUBLIC_API_ENDPOINTS).map((endpoint) => {
  const [method, path] = endpoint!.split(" ");
  return { method, path: new RegExp(`^${path!.replace(/:[A-Za-z]+/g, "[^/]+")}$`) };
});
export function isPublicApiOperation(method: string, path: string): boolean {
  return routes.some((route) => route.method === method && route.path.test(path));
}
