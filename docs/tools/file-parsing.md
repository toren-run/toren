# File parsing <Badge type="warning" text="coming soon" />

Hand a run files, not just strings: PDFs, spreadsheets, and documents as first-class inputs, parsed into text your agents can read, with the extracted content recorded in the event log so replay never re-parses.

The planned shape:

- Upload through the API (`POST /runs` and `POST /sessions` grow a files field) or reference an S3 object your deployment can read.
- Files land in blob storage keyed by content hash; the event log stores the reference, never the bytes.
- A built-in `read_file` tool gives agents paged access to the parsed text, so a 200-page PDF does not detonate the context window.

Until it ships, the pattern that works today: put the file where your tool can reach it (S3, a URL, a database) and write a `defineTool()` that fetches and extracts the part the agent asks for. See [Defining tools](/tools/defining-tools).
