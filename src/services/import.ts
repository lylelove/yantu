import type { Paper } from "../game/types";
import { normalizeDoi } from "./openalex";

/** A problem that can be shown in the import preview without aborting the file. */
export interface ImportIssue {
  record?: number;
  message: string;
}

export interface ImportResult {
  papers: Paper[];
  /** Number of records recognised by the selected parser, including duplicates. */
  parsed: number;
  skipped: number;
  duplicates: number;
  issues: ImportIssue[];
}

type RawRecord = Record<string, unknown>;

const MAX_ISSUES = 50;

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function cleanMarkup(value: string): string {
  const accents: Record<string, Record<string, string>> = {
    '"': { a: "ä", e: "ë", i: "ï", o: "ö", u: "ü", A: "Ä", E: "Ë", I: "Ï", O: "Ö", U: "Ü" },
    "'": { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú" },
    "`": { a: "à", e: "è", i: "ì", o: "ò", u: "ù", A: "À", E: "È", I: "Ì", O: "Ò", U: "Ù" },
    "^": { a: "â", e: "ê", i: "î", o: "ô", u: "û", A: "Â", E: "Ê", I: "Î", O: "Ô", U: "Û" },
    "~": { a: "ã", n: "ñ", o: "õ", A: "Ã", N: "Ñ", O: "Õ" },
    "=": { a: "ā", e: "ē", i: "ī", o: "ō", u: "ū", A: "Ā", E: "Ē", I: "Ī", O: "Ō", U: "Ū" },
    ".": { c: "ċ", C: "Ċ", z: "ż", Z: "Ż" },
  };
  return value
    .replace(/\\(["'`^~=.])\s*\{?([A-Za-z])\}?/g, (_, accent: string, letter: string) => accents[accent]?.[letter] ?? letter)
    .replace(/\\(?:textit|textbf|emph|textrm|textnormal|url)\s*/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\\([\\%,#&_])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitList(value: string): string[] {
  return value
    .split(/[;,|]\s*|\n+/)
    .map((part) => cleanMarkup(part))
    .filter(Boolean);
}

function splitAuthors(value: string): string[] {
  return value
    .split(/\s+and\s+|;\s*|\n+/i)
    .map((author) => cleanMarkup(author))
    .filter(Boolean);
}

function normaliseAuthor(value: string): string {
  const cleaned = cleanMarkup(value);
  if (!cleaned.includes(",")) return cleaned;
  const parts = cleaned.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`.trim();
  // BibTeX's three-part form is `von Last, Jr, First`.
  return [parts[2], parts[0], parts[1]].filter(Boolean).join(" ");
}

function yearOf(value: unknown): number {
  if (value && typeof value === "object") {
    const dateParts = (value as Record<string, unknown>)["date-parts"];
    if (Array.isArray(dateParts) && typeof dateParts[0]?.[0] === "number") {
      return dateParts[0][0];
    }
  }
  const match = text(value).match(/(?:18|19|20|21)\d{2}/);
  return match ? Number(match[0]) : 0;
}

function valueOf(record: RawRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key] ?? Object.entries(record).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    const result = text(value);
    if (result) return result;
  }
  return "";
}

function authorsOf(record: RawRecord): string[] {
  const value = record.authors ?? record.author ?? record.creators;
  if (Array.isArray(value)) {
    return value
      .map((author) => {
        if (typeof author === "string") return author;
        if (!author || typeof author !== "object") return "";
        const a = author as Record<string, unknown>;
        return [
          text(a.given ?? a.firstName),
          text(a.family ?? a.lastName),
        ].filter(Boolean).join(" ") || text(a.name);
      })
      .map(normaliseAuthor)
      .filter(Boolean);
  }
  return splitAuthors(text(value)).map(normaliseAuthor);
}

function keywordsOf(record: RawRecord): string[] {
  const value = record.keywords ?? record.keyword ?? record.tags;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? text((item as Record<string, unknown>).tag) : ""))
      .flatMap(splitList);
  }
  return splitList(text(value));
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function identityFor(title: string, authors: string[], year: number): string {
  const key = `${title.toLowerCase()}|${authors.join("|").toLowerCase()}|${year}`;
  return `local:${stableHash(key)}`;
}

function rawToPaper(record: RawRecord): Paper | null {
  const title = cleanMarkup(valueOf(record, "title", "name"));
  if (!title) return null;

  const authors = authorsOf(record);
  const year = yearOf(record.year) || yearOf(record.date) || yearOf(record.issued);
  const rawDoi = valueOf(record, "doi", "DOI");
  const doi = rawDoi ? normalizeDoi(rawDoi) : "";
  const rawId = valueOf(record, "id", "key", "citationKey");
  const arxiv = valueOf(record, "arxiv", "arXiv").replace(/^arxiv:/i, "").trim();
  const id = doi
    ? `doi:${doi}`
    : arxiv
      ? `arxiv:${arxiv.toLowerCase()}`
      : identityFor(title, authors, year);
  const aliases = new Set<string>();
  if (rawId && rawId !== id) aliases.add(rawId);
  if (arxiv && id !== `arxiv:${arxiv.toLowerCase()}`) aliases.add(`arxiv:${arxiv.toLowerCase()}`);

  const keywords = keywordsOf(record);
  const abstract = cleanMarkup(valueOf(record, "abstract", "abstractNote", "summary"));
  const urlValue = cleanMarkup(valueOf(record, "url", "URL", "link"));
  const url = urlValue || undefined;
  const paper: Paper = {
    id,
    title,
    authors,
    year,
    venue: cleanMarkup(valueOf(record, "venue", "journal", "journaltitle", "booktitle", "publicationTitle", "container-title", "containerTitle", "publisher", "school", "institution")),
    abstract,
    keywords,
    citedByCount: Math.max(0, Number(valueOf(record, "citedByCount", "cited", "citationCount")) || 0),
    references: [],
    doi: doi || undefined,
    url,
    source: "import",
    aliases: aliases.size > 0 ? [...aliases].sort() : undefined,
  };
  return paper;
}

function emptyResult(): ImportResult {
  return { papers: [], parsed: 0, skipped: 0, duplicates: 0, issues: [] };
}

function pushIssue(result: ImportResult, issue: ImportIssue): void {
  if (result.issues.length < MAX_ISSUES) result.issues.push(issue);
}

function finish(records: RawRecord[], initialIssues: ImportIssue[] = []): ImportResult {
  const result = emptyResult();
  result.issues.push(...initialIssues.slice(0, MAX_ISSUES));
  const byId = new Map<string, Paper>();

  records.forEach((record, index) => {
    result.parsed++;
    const paper = rawToPaper(record);
    if (!paper) {
      result.skipped++;
      pushIssue(result, { record: index + 1, message: "缺少标题，已跳过。" });
      return;
    }
    if (byId.has(paper.id)) {
      result.duplicates++;
      return;
    }
    byId.set(paper.id, paper);
  });

  result.papers = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  result.skipped += Math.max(0, initialIssues.filter((issue) => issue.message.includes("无法识别")).length);
  return result;
}

/** Parse a CSV while respecting quoted commas, doubled quotes, and newlines. */
function parseCsv(textValue: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < textValue.length; i++) {
    const char = textValue[i];
    if (char === '"') {
      if (quoted && textValue[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && textValue[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function parseCsvRecords(input: string): RawRecord[] {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim().toLowerCase());
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""])));
}

/** Read a RIS file. Continuation lines are appended to the preceding field. */
function parseRisRecords(input: string): RawRecord[] {
  const records: RawRecord[] = [];
  let current: RawRecord | null = null;
  let lastTag = "";
  for (const line of input.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9]{2})\s*-\s?(.*)$/i);
    if (!match) {
      if (current && lastTag && line.trim()) current[lastTag] = `${text(current[lastTag])} ${line.trim()}`;
      continue;
    }
    const tag = match[1].toUpperCase();
    const value = match[2].trim();
    if (tag === "TY") {
      if (current) records.push(current);
      current = {};
    }
    if (!current) continue;
    const key = ({ TI: "title", T1: "title", AU: "authors", A1: "authors", PY: "year", Y1: "year", JO: "venue", JF: "venue", AB: "abstract", N2: "abstract", KW: "keywords", DO: "doi", UR: "url" } as Record<string, string>)[tag];
    if (key) {
      if (key === "authors" || key === "keywords") current[key] = [...(Array.isArray(current[key]) ? current[key] : []), value];
      else current[key] = value;
      lastTag = key;
    } else if (tag === "ER") {
      records.push(current);
      current = null;
      lastTag = "";
    }
  }
  if (current) records.push(current);
  return records;
}

const BIBTEX_METADATA_TYPES = new Set(["comment", "preamble", "string"]);

const BUILTIN_BIBTEX_MACROS: Record<string, string> = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  oct: "October",
  nov: "November",
  dec: "December",
};

/** Find the matching brace/parenthesis, respecting nested values and quotes. */
function bibtexClosingIndex(input: string, start: number): number {
  const stack: string[] = [input[start]];
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"') {
      i++;
      while (i < input.length) {
        if (input[i] === "\\") {
          i++;
        } else if (input[i] === '"') {
          break;
        }
        i++;
      }
      continue;
    }
    if (char === "%") {
      const lineEnd = input.indexOf("\n", i);
      i = lineEnd < 0 ? input.length : lineEnd;
      continue;
    }
    if (char === "{" || char === "(") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === ")") {
      const expected = char === "}" ? "{" : "(";
      if (stack[stack.length - 1] === expected) stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function skipBibtexSpace(input: string, index: number): number {
  let i = index;
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }
    if (input[i] === "%") {
      const lineEnd = input.indexOf("\n", i);
      i = lineEnd < 0 ? input.length : lineEnd + 1;
      continue;
    }
    break;
  }
  return i;
}

function readBibtexValue(
  input: string,
  start: number,
  macros: Record<string, string>,
): { value: string; next: number } {
  const index = skipBibtexSpace(input, start);
  if (index >= input.length) return { value: "", next: index };

  if (input[index] === "{" || input[index] === "(") {
    const end = bibtexClosingIndex(input, index);
    if (end < 0) return { value: input.slice(index + 1), next: input.length };
    return { value: input.slice(index + 1, end), next: end + 1 };
  }

  if (input[index] === '"') {
    let end = index + 1;
    while (end < input.length) {
      if (input[end] === "\\") {
        end += 2;
        continue;
      }
      if (input[end] === '"') break;
      end++;
    }
    return { value: input.slice(index + 1, end), next: Math.min(input.length, end + 1) };
  }

  let end = index;
  while (end < input.length && input[end] !== "," && input[end] !== "#" && !/\s/.test(input[end])) {
    end++;
  }
  const token = input.slice(index, end).trim();
  return { value: macros[token.toLowerCase()] ?? token, next: end };
}

function parseBibtexFields(input: string, macros: Record<string, string>): RawRecord {
  const record: RawRecord = {};
  let index = 0;
  while (index < input.length) {
    index = skipBibtexSpace(input, index);
    while (input[index] === ",") index = skipBibtexSpace(input, index + 1);
    if (index >= input.length) break;

    const nameStart = index;
    while (index < input.length && /[A-Za-z0-9_:-]/.test(input[index])) index++;
    const name = input.slice(nameStart, index).toLowerCase();
    index = skipBibtexSpace(input, index);
    if (!name || input[index] !== "=") {
      while (index < input.length && input[index] !== ",") index++;
      continue;
    }
    index = skipBibtexSpace(input, index + 1);

    const values: string[] = [];
    while (index < input.length) {
      const part = readBibtexValue(input, index, macros);
      values.push(part.value);
      index = skipBibtexSpace(input, part.next);
      if (input[index] !== "#") break;
      index = skipBibtexSpace(input, index + 1);
    }
    record[name] = values.join("");
    while (index < input.length && input[index] !== ",") index++;
  }
  return record;
}

function findBibtexFieldComma(input: string): number {
  const stack: string[] = [];
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "{" || char === "(") stack.push(char);
    else if (char === "}" || char === ")") stack.pop();
    else if (char === "," && stack.length === 0) return i;
  }
  return -1;
}

function parseBibtexRecords(input: string): RawRecord[] {
  const records: RawRecord[] = [];
  const macros = { ...BUILTIN_BIBTEX_MACROS };
  let cursor = 0;

  while (cursor < input.length) {
    const at = input.indexOf("@", cursor);
    if (at < 0) break;
    let typeEnd = at + 1;
    while (typeEnd < input.length && /[A-Za-z]/.test(input[typeEnd])) typeEnd++;
    const type = input.slice(at + 1, typeEnd).toLowerCase();
    const open = skipBibtexSpace(input, typeEnd);
    if (input[open] !== "{" && input[open] !== "(") {
      cursor = typeEnd;
      continue;
    }
    const close = bibtexClosingIndex(input, open);
    if (close < 0) break;
    const body = input.slice(open + 1, close);

    // Definitions such as @string{jmlr = "Journal of Machine Learning Research"}
    // are useful to resolve later fields, but are not papers themselves.
    if (type === "string") {
      Object.assign(macros, parseBibtexFields(body, macros));
    } else if (!BIBTEX_METADATA_TYPES.has(type)) {
      const comma = findBibtexFieldComma(body);
      if (comma >= 0) {
        const key = body.slice(0, comma).trim();
        if (key) records.push({ key, ...parseBibtexFields(body.slice(comma + 1), macros) });
      }
    }
    cursor = close + 1;
  }
  return records;
}
function jsonRecords(input: string): RawRecord[] {
  const parsed: unknown = JSON.parse(input);
  let candidates: unknown[];
  if (Array.isArray(parsed)) {
    candidates = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).items)
  ) {
    candidates = (parsed as Record<string, unknown>).items as unknown[];
  } else {
    candidates = [parsed];
  }
  return candidates.filter(
    (item: unknown): item is RawRecord =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
}

function detectedFormat(input: string, filename: string): "bib" | "ris" | "csv" | "json" | "unknown" {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "bib" || ext === "bibtex") return "bib";
  if (ext === "ris") return "ris";
  if (ext === "csv") return "csv";
  if (ext === "json") return "json";
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) return "bib";
  if (/^TY\s*-\s?/im.test(input)) return "ris";
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "json";
  if (input.includes(",")) return "csv";
  return "unknown";
}

/** Parse Zotero/CSL exports and common bibliography interchange formats. */
export function parseBibliography(input: string, filename = ""): ImportResult {
  const result = emptyResult();
  if (!input.trim()) {
    result.issues.push({ message: "文件为空。" });
    return result;
  }

  try {
    const format = detectedFormat(input, filename);
    let records: RawRecord[];
    if (format === "bib") records = parseBibtexRecords(input);
    else if (format === "ris") records = parseRisRecords(input);
    else if (format === "csv") records = parseCsvRecords(input);
    else if (format === "json") records = jsonRecords(input);
    else {
      result.issues.push({ message: "无法识别文件格式，请选择 BibTeX、RIS、CSV 或 JSON 文件。" });
      return result;
    }
    if (records.length === 0) {
      result.issues.push({ message: "没有识别到文献记录。" });
      return result;
    }
    return finish(records);
  } catch (error) {
    result.issues.push({ message: `解析失败：${error instanceof Error ? error.message : "文件内容无效"}` });
    return result;
  }
}
