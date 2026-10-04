// Placeholder — owned by the edge workstream. Exports the ProjectDO class for wrangler.
export { ProjectDO } from "./do/ProjectDO";

export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: { code: "INTERNAL", message: "Not implemented yet" } }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
