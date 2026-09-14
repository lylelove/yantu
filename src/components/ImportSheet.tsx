import { useRef, useState } from "react";

import type { Paper } from "../game/types";
import { parseBibliography, type ImportIssue } from "../services/import";
import { useStore } from "../state/store";

/**
 * Import dialog.
 *
 * Files are read in the webview with `FileReader` rather than through a Tauri
 * filesystem plugin. That keeps one code path for both the desktop app and the
 * browser build, and means the app never holds filesystem permissions it does
 * not need — we only ever see the bytes the user explicitly hands us, and the
 * original file is never written to.
 *
 * Parsing is always previewed before it is committed. Import is the one place
 * where a silent mistake would quietly corrupt someone's map, so the counts and
 * the problems are shown first and nothing lands until the user says so.
 */

interface Staged {
  papers: Paper[];
  parsed: number;
  skipped: number;
  duplicates: number;
  issues: ImportIssue[];
  files: string[];
}

export default function ImportSheet({ onClose }: { onClose: () => void }) {
  const addPapers = useStore((s) => s.addPapers);
  const notify = useStore((s) => s.notify);

  const [staged, setStaged] = useState<Staged | null>(null);
  const [pasted, setPasted] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /** Parse one text blob and fold it into the staged preview. */
  const stage = (text: string, filename: string) => {
    const result = parseBibliography(text, filename);
    setStaged((prev) => {
      if (!prev) {
        return {
          papers: result.papers,
          parsed: result.parsed,
          skipped: result.skipped,
          duplicates: result.duplicates,
          issues: result.issues,
          files: [filename],
        };
      }
      // Accumulate across several dropped files, keeping issues bounded.
      return {
        papers: [...prev.papers, ...result.papers],
        parsed: prev.parsed + result.parsed,
        skipped: prev.skipped + result.skipped,
        duplicates: prev.duplicates + result.duplicates,
        issues: [...prev.issues, ...result.issues].slice(0, 50),
        files: [...prev.files, filename],
      };
    });
  };

  const readFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        stage(text, file.name);
      } catch {
        notify("error", `读不到文件 ${file.name}`);
      }
    }
  };

  const commit = () => {
    if (!staged || staged.papers.length === 0) return;
    const { added, merged } = addPapers(staged.papers);
    notify(
      "info",
      `导入完成：新增 ${added} 篇${merged > 0 ? `，与已有记录合并 ${merged} 篇` : ""}。`,
    );
    onClose();
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="导入文献"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet">
        <h2>导入文献</h2>
        <p>
          支持 Zotero 导出的 CSV、BibTeX（.bib）、RIS（.ris）和 JSON。文件只读解析，不会被修改；
          导入的文献会作为你「已知的世界」，其余留在迷雾里。
        </p>

        <div
          className={`drop-zone${dragging ? " dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void readFiles(e.dataTransfer.files);
          }}
        >
          <p style={{ margin: "0 0 9px" }}>把文件拖到这里</p>
          <button type="button" onClick={() => fileInput.current?.click()}>
            选择文件
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".bib,.ris,.csv,.json,.txt"
            hidden
            onChange={(e) => {
              if (e.target.files) void readFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        <label style={{ display: "block", fontSize: 11, color: "var(--ink-faint)" }}>
          或者直接粘贴内容
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="@article{...} 或 TY  - JOUR ..."
            style={{ marginTop: 5 }}
          />
        </label>
        {pasted.trim() && (
          <div className="sheet-actions" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => stage(pasted, "粘贴的内容")}>
              解析粘贴的内容
            </button>
          </div>
        )}

        {staged && (
          <div className="import-report">
            <p style={{ margin: 0 }}>
              来自 {staged.files.join("、")}：识别 <strong>{staged.parsed}</strong> 条，
              可导入 <strong>{staged.papers.length}</strong> 篇
              {staged.duplicates > 0 && <>，文件内重复 <strong>{staged.duplicates}</strong> 条</>}
              {staged.skipped > 0 && <>，跳过 <strong>{staged.skipped}</strong> 条</>}。
            </p>
            {staged.issues.length > 0 && (
              <ul>
                {staged.issues.slice(0, 6).map((issue, i) => (
                  <li key={i}>
                    {issue.record !== undefined ? `第 ${issue.record} 条：` : ""}
                    {issue.message}
                  </li>
                ))}
                {staged.issues.length > 6 && <li>……还有 {staged.issues.length - 6} 条提示</li>}
              </ul>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={commit}
            disabled={!staged || staged.papers.length === 0}
          >
            导入 {staged?.papers.length ?? 0} 篇
          </button>
        </div>
      </div>
    </div>
  );
}
