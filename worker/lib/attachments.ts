/** R2 layout of receipt photos: projects/<projectId>/attachments/<attachmentId>. */
const R2_DELETE_BATCH = 1000;

export const attachmentPrefix = (projectId: string) => `projects/${projectId}/attachments/`;
export const attachmentKey = (projectId: string, attachmentId: string) => `${attachmentPrefix(projectId)}${attachmentId}`;

/** Deletes every object under `prefix`, a page at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: R2_DELETE_BATCH });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
