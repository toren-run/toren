import { expect, test } from "vitest";
import { MAX_FILE_BYTES, PAGE_CHARS, paginate, parseFile } from "../src/files.js";

test("paginate splits on the page boundary and never returns empty", () => {
  expect(paginate("")).toEqual([""]);
  expect(paginate("short")).toEqual(["short"]);
  const long = "x".repeat(PAGE_CHARS * 2 + 100);
  const pages = paginate(long);
  expect(pages.length).toBe(3);
  expect(pages[0]!.length).toBe(PAGE_CHARS);
  expect(pages.join("")).toBe(long);
});

test("text formats parse to utf8 pages", async () => {
  const r = await parseFile("notes.md", Buffer.from("# Title\n\nHello file world."));
  expect(r.mediaType).toBe("text/markdown");
  expect(r.pages[0]).toContain("Hello file world.");
});

test("xlsx parses to per-sheet CSV text", async () => {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["city", "temp"], ["SF", 18], ["NYC", 28]]), "weather");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const r = await parseFile("data.xlsx", buf);
  expect(r.pages[0]).toContain("## Sheet: weather");
  expect(r.pages[0]).toContain("SF,18");
});

test("binary junk with an unknown extension is rejected with the supported list", async () => {
  const junk = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7 + 200) % 256));
  await expect(parseFile("blob.bin", junk)).rejects.toThrow(/supported: pdf, docx, xlsx/);
});

test("oversized files are rejected", async () => {
  const big = Buffer.alloc(MAX_FILE_BYTES + 1);
  await expect(parseFile("big.txt", big)).rejects.toThrow(/too large/);
});
