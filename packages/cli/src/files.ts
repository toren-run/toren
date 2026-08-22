/**
 * Upload-time file parsing: bytes in, pages of plain text out. Parsing happens
 * exactly once here; agents consume the pages through the read_file builtin,
 * so a resumed run replays recorded reads and never re-parses.
 */

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const PAGE_CHARS = 4_000;

const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  yaml: "text/yaml", yml: "text/yaml", html: "text/html", xml: "text/xml", log: "text/plain",
};

export function paginate(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length === 0) return [""];
  const pages: string[] = [];
  for (let i = 0; i < clean.length; i += PAGE_CHARS) pages.push(clean.slice(i, i + PAGE_CHARS));
  return pages;
}

export async function parseFile(name: string, data: Buffer): Promise<{ mediaType: string; pages: string[] }> {
  if (data.length > MAX_FILE_BYTES) throw new Error(`file too large (${data.length} bytes; max ${MAX_FILE_BYTES})`);
  const ext = (name.split(".").at(-1) ?? "").toLowerCase();

  if (ext === "pdf" || data.subarray(0, 5).toString("latin1") === "%PDF-") {
    const { default: pdfParse } = await import("pdf-parse");
    const parsed = await pdfParse(data);
    return { mediaType: "application/pdf", pages: paginate(parsed.text) };
  }

  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const out = await mammoth.extractRawText({ buffer: data });
    return { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pages: paginate(out.value) };
  }

  if (ext === "xlsx" || ext === "xls") {
    // Optional peer: SheetJS carries upstream npm-audit advisories, so a fresh
    // install stays clean and spreadsheet users opt in explicitly.
    const XLSX = await import("xlsx").catch(() => {
      throw new Error('spreadsheet parsing needs the optional "xlsx" package: npm install xlsx');
    });
    const wb = XLSX.read(data, { type: "buffer" });
    const sheets = wb.SheetNames.map((n) => `## Sheet: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n]!)}`);
    return { mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pages: paginate(sheets.join("\n\n")) };
  }

  const mediaType = TEXT_TYPES[ext];
  if (mediaType) return { mediaType, pages: paginate(data.toString("utf8")) };

  // Unknown extension: accept it if it decodes as reasonable UTF-8 text.
  const text = data.toString("utf8");
  const junk = [...text.slice(0, 2000)].filter((c) => c === "�").length;
  if (junk > 5) {
    throw new Error(`unsupported file type ".${ext}" — supported: pdf, docx, xlsx, and text formats (${Object.keys(TEXT_TYPES).join(", ")})`);
  }
  return { mediaType: "text/plain", pages: paginate(text) };
}
