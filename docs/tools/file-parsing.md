# File parsing

Hand your agents files, not just strings: PDF, Word (docx), Excel (xlsx), and any text format (markdown, CSV, JSON, YAML, HTML, logs). Files are parsed to plain text exactly once at upload, stored by content hash, and read by agents page by page, so a 200-page PDF never detonates a context window.

## Upload, attach, read

Upload through the API (or the console's paperclip button in any chat):

```bash
curl -X POST "$TOREN_URL/files" \
  -H "Authorization: Bearer $TOREN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"report.pdf\", \"content_base64\": \"$(base64 -i report.pdf)\"}"
```

The response is `{"fileId": "ab12cd34ef567890", "pages": 12, ...}`. Attach the id to a run or a session message (or skip the upload dance entirely from the CLI: `toren run . --input "Summarize the report" --file ./report.pdf`, and `toren chat --file` for conversations; both parse locally through the same pipeline):

```bash
curl -X POST "$TOREN_URL/sessions" \
  -H "Authorization: Bearer $TOREN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent": "analyst", "message": "Summarize the attached report.", "files": ["ab12cd34ef567890"]}'
```

The attachment becomes a manifest line in the recorded message, visible in the transcript, and the agent reads the content with the `read_file` builtin:

```yaml
name: analyst
model: anthropic/claude-sonnet-5
builtin_tools: [read_file]
```

Attaching a file to an agent that lacks `read_file` is a clear 400 at the API, never a silent no-op. The typed client wraps the whole flow: `client.uploadFile({name, data})`, then `files: [...]` on `startRun`, `startSession`, and `sendSessionMessage`.

## Durability

Parsing happens once, at upload. Every `read_file` call is recorded in the event log with keyed idempotency, so a killed and resumed run replays its recorded reads: the agent reasons over the same pages before and after a crash, verified by digest, and never re-reads what it already read. Large tool results from reading, like everything else, are subject to [context compaction](/concepts/durability#context-compaction-an-event-in-the-log): old pages elide to restorable stubs the agent can re-fetch by calling `read_file` again.

## Limits

Files up to 15 MB. Pages are ~4,000 characters of extracted text. Excel sheets extract as per-sheet CSV. Scanned PDFs without a text layer extract poorly (no OCR yet). Images are not supported yet.
