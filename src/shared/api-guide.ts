/** Copyable examples shared by the website and the plain-text guide for AI clients. */
export function apiExamples(origin: string) {
  return {
    list: `# Set your key in your environment; keep it out of source control.
export SPLITDUMMY_API_KEY="sd_REPLACE_WITH_YOUR_KEY"

curl --fail-with-body "${origin}/api/projects" \\
  -H "Authorization: Bearer $SPLITDUMMY_API_KEY"`,
    group: `# Replace p_REPLACE with an id from the groups response.
curl --fail-with-body "${origin}/api/projects/p_REPLACE" \\
  -H "Authorization: Bearer $SPLITDUMMY_API_KEY"`,
    python: `# Python 3, standard library only. Requires a read/write key.
# Set SPLITDUMMY_API_KEY and SPLITDUMMY_PROJECT_ID before running.
import json
import os
import uuid
from datetime import date
from urllib.request import Request, urlopen

BASE = "${origin}"
TOKEN = os.environ["SPLITDUMMY_API_KEY"]
PROJECT = os.environ["SPLITDUMMY_PROJECT_ID"]

def request(method, path, body=None, idempotency_key=None):
    headers = {"Authorization": "Bearer " + TOKEN}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    req = Request(BASE + path, data=data, headers=headers, method=method)
    with urlopen(req, timeout=30) as response:
        return json.load(response)

view = request("GET", "/api/projects/" + PROJECT)
round_id = view["current"]["round"]["id"]
if view["current"]["round"]["status"] != "COLLECTING":
    raise SystemExit("This round is frozen; add expenses to a collecting round.")

expense = {
    "type": "EXPENSE",
    "description": "Lunch",
    "occurredAt": date.today().isoformat(),
    "originalAmount": "1250",  # Minor units; 12.50 if exponent is 2.
    "originalCurrency": view["project"]["baseCurrency"],
    "conversion": {"method": "IDENTITY"},
    "payerMemberId": view["me"]["memberId"],
    "splitMode": "EQUAL",
    "participants": [
        {"memberId": member["id"]}
        for member in view["members"] if member["status"] == "ACTIVE"
    ],
}
# Reuse this UUID and the same expense body if retrying a failed request.
action_key = str(uuid.uuid4())
entry = request("POST", "/api/projects/" + PROJECT + "/rounds/" + round_id + "/entries",
                expense, action_key)
print("Created expense:", entry["id"])`,
  };
}

export function apiGuide(origin: string): string {
  const examples = apiExamples(origin);
  return `# Splitdummy API

Use your groups from scripts and AI tools. Base URL: ${origin}
This guide (Markdown, for AI tools): ${origin}/docs/api.md
Human guide: ${origin}/docs/api
OpenAPI 3.1 schema: ${origin}/api/openapi.json

## Authentication
Sign in with your email on the website. Open Account → API keys, choose Read only or Read and write, and create a key.
The secret is shown once. Keys expire after 90 days and can be revoked immediately in Account.
Send Authorization: Bearer <key> on every API request. Cookies and Origin headers are unnecessary.
Read-only keys can read groups, rounds, balances, reviews, history and CSV exports.
Read/write keys can also change groups according to your existing membership and role.
Keys cannot manage API keys, change account identity, delete accounts or use WebSockets. Join groups on the website.
All keys for one account share the existing rate limits. Handle HTTP 429 with a delay.

## List your groups
\`\`\`sh
${examples.list}
\`\`\`
Returns an array of groups. Use the id field as projectId.

## Read expenses and balances
\`\`\`sh
${examples.group}
\`\`\`
The response contains project, me, members, rates, current and rounds.
Use current.round.id as roundId, me.memberId as your memberId, and members[].id for participants.
Members with kind PLACEHOLDER were added by the owner and have not joined yet; they can still pay and share expenses.
Current balances are in current.balances. Positive net means receives; negative net means owes.

## Add an expense with Python
This example adds a lunch expense, paid by you, split equally between all active members of the selected group.
Set SPLITDUMMY_PROJECT_ID to the group id you chose from the list. Review the expense and participants before running.
\`\`\`python
${examples.python}
\`\`\`

## Notes and receipt photos
Expenses and refunds accept an optional note (up to 1000 characters) and up to 5 photos.
1. Upload each photo: POST /api/projects/{projectId}/attachments with the image bytes as the body, Content-Type image/jpeg or image/webp, and an Idempotency-Key. At most 1.5 MB and 4096 px per side. The response contains the photo id.
2. Save the expense with "attachmentIds": ["att_…"] in display order.
Photo metadata, including EXIF orientation, is removed, so upload upright images. An uploaded photo is visible only to you until it is attached; unattached uploads are deleted after 24 hours.
On updates, omitting note or attachmentIds keeps them; null or [] clears them. Download a photo with GET /api/projects/{projectId}/attachments/{attachmentId}.

## Data and retries
- Money is an integer string in minor units, never a floating-point number. "1250" = 12.50 PLN/EUR/USD (exponent 2), 1250 JPY (0), or 1.250 KWD (3). Use project.baseExponent or entry.originalExponent.
- occurredAt is YYYY-MM-DD. Other timestamps are ISO 8601 UTC strings.
- EQUAL splits omit participant amounts. EXACT splits include original minor-unit amount strings which must add up to originalAmount.
- IDENTITY conversion is for the group base currency. Foreign currencies require multi-currency to be enabled and MANUAL_RATE or ACTUAL_BASE_AMOUNT conversion.
- Every group mutation requires Idempotency-Key: <new UUID>. Reuse the same UUID and body when retrying the same action; use a fresh UUID for a new action.
- Updates/deletions use expectedRevision or expectedVersion from the latest response. Refetch on a stale-version error before deciding what to submit.
- Expenses can only change during COLLECTING. Frozen rounds use settlement instructions.
- Transfer actions record real-world payments; Splitdummy never moves money.

## Common endpoints
GET /api/me — your identity
GET /api/projects — your groups
GET /api/projects/{projectId} — group, members, current expenses and balances
POST /api/projects/{projectId}/rounds/{roundId}/entries — add an expense or refund
POST /api/projects/{projectId}/attachments — upload a receipt photo (raw image body)
GET /api/projects/{projectId}/attachments/{attachmentId} — download a receipt photo
GET /api/projects/{projectId}/rounds/{roundId}/review — proposed settlement
GET /api/projects/{projectId}/export — CSV export
The OpenAPI schema describes all supported group operations, request fields and responses.

## Errors
Errors are JSON: {"error":{"code":"VALIDATION","message":"...","field":"originalAmount"}}. field and details are optional.
401: invalid, revoked or expired key. 403: read-only key or insufficient role. 404: unavailable or not a member.
409: stale revision, frozen round, state conflict or changed content under an existing idempotency key.
422: invalid input. 429: rate limited. 500: unexpected server error (use X-Request-Id when reporting).

## AI tools
Import ${origin}/api/openapi.json into an OpenAPI-compatible tool and configure bearer authentication with your key.
For clients that need text, use ${origin}/docs/api.md. Start with a read-only key for summaries and balances.
For write tools, look up current group/member/round IDs rather than guessing. Ask the user to confirm expenses, participants and payment confirmations before submitting.
Keep the key in the tool's secret configuration or environment, outside prompts and shared chats.
`;
}
