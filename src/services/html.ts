import type { DiffResult } from "../schemas.js";
// Vite inlines the stylesheet as a string at build time via the `?raw` query,
// so the generated HTML stays a single self-contained artifact while the CSS
// source lives in a dedicated file for readability.
import diffHtmlStyles from "./diff-html.css?raw";

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

export interface ParsedDiff {
  oldPath?: string;
  newPath?: string;
  added: string[];
  removed: string[];
  changed: string[];
  sizeBefore?: string;
  sizeAfter?: string;
  diffSize?: string;
  unparsed: string[];
}

// Best-effort parser for dix output. Falls back gracefully by dumping
// anything unrecognized into `unparsed` so the viewer can render it verbatim
// via the Raw dix output section.
export const parseDiff = (diff: string): ParsedDiff => {
  const result: ParsedDiff = {
    added: [],
    removed: [],
    changed: [],
    unparsed: [],
  };
  const lines = diff.split("\n");
  let section: "added" | "removed" | "changed" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) {
      section = null;
      continue;
    }
    const oldPath = /^<<<\s+(.+)$/.exec(line);
    if (oldPath) {
      result.oldPath = oldPath[1];
      continue;
    }
    const newPath = /^>>>\s+(.+)$/.exec(line);
    if (newPath) {
      result.newPath = newPath[1];
      continue;
    }
    if (line === "ADDED") {
      section = "added";
      continue;
    }
    if (line === "REMOVED") {
      section = "removed";
      continue;
    }
    if (line === "CHANGED") {
      section = "changed";
      continue;
    }
    const size = /^SIZE:\s*(.+?)\s*->\s*(.+)$/.exec(line);
    if (size) {
      result.sizeBefore = size[1];
      result.sizeAfter = size[2];
      section = null;
      continue;
    }
    const diffSize = /^DIFF:\s*(.+)$/.exec(line);
    if (diffSize) {
      result.diffSize = diffSize[1];
      section = null;
      continue;
    }
    if (section) {
      result[section].push(line);
    } else {
      result.unparsed.push(line);
    }
  }
  return result;
};

// dix prefixes entries like "[A.] pkgname   1.2.3". The bracketed marker is
// currently 2 chars in dix but we allow {1,4} so format tweaks don't silently
// break stripping — the surrounding section already conveys ADDED/REMOVED/CHANGED.
export const stripPrefix = (line: string): string => line.replace(/^\[[A-Za-z.]{1,4}\]\s*/, "");

export const isUnchanged = (parsed: ParsedDiff): boolean =>
  parsed.added.length === 0 && parsed.removed.length === 0 && parsed.changed.length === 0;

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "diff";

const renderEntryRows = (lines: readonly string[]): string =>
  lines
    .map((line) => {
      const stripped = stripPrefix(line);
      // dix aligns name/version with whitespace; split on 2+ spaces to get two
      // columns when possible, otherwise show the whole line in one column.
      const match = /^(\S+)\s{2,}(.+)$/.exec(stripped);
      if (match) {
        return `<tr><td class="pkg-name"><code>${escapeHtml(match[1])}</code></td><td class="pkg-ver"><code>${escapeHtml(match[2])}</code></td></tr>`;
      }
      return `<tr><td class="pkg-name" colspan="2"><code>${escapeHtml(stripped)}</code></td></tr>`;
    })
    .join("");

const renderChangeSection = (
  kind: "added" | "removed" | "changed",
  label: string,
  lines: readonly string[],
): string => {
  if (lines.length === 0) return "";
  return `
      <details open class="change-group change-${kind}">
        <summary class="change-heading">
          <span class="change-badge">${label}</span>
          <span class="change-count">${lines.length}</span>
        </summary>
        <table class="change-table">
          <tbody>${renderEntryRows(lines)}</tbody>
        </table>
      </details>`;
};

const renderNoChanges = (parsed: ParsedDiff): string =>
  isUnchanged(parsed)
    ? `<p class="no-changes">No package additions, removals, or version changes.</p>`
    : "";

const renderStats = (parsed: ParsedDiff): string => {
  const stats: string[] = [];
  if (parsed.sizeBefore && parsed.sizeAfter) {
    stats.push(
      `<div class="stat"><span class="stat-label">Closure size</span><span class="stat-value"><code>${escapeHtml(parsed.sizeBefore)}</code> <span class="arrow">→</span> <code>${escapeHtml(parsed.sizeAfter)}</code></span></div>`,
    );
  }
  if (parsed.diffSize) {
    stats.push(
      `<div class="stat"><span class="stat-label">Diff size</span><span class="stat-value"><code>${escapeHtml(parsed.diffSize)}</code></span></div>`,
    );
  }
  // The no-changes banner already says "nothing added/removed/changed", so skip
  // the three zero-valued chips to avoid visual noise.
  if (!isUnchanged(parsed)) {
    stats.push(
      `<div class="stat"><span class="stat-label">Added</span><span class="stat-value stat-added">${parsed.added.length}</span></div>`,
    );
    stats.push(
      `<div class="stat"><span class="stat-label">Removed</span><span class="stat-value stat-removed">${parsed.removed.length}</span></div>`,
    );
    stats.push(
      `<div class="stat"><span class="stat-label">Changed</span><span class="stat-value stat-changed">${parsed.changed.length}</span></div>`,
    );
  }
  if (stats.length === 0) return "";
  return `<div class="stats">${stats.join("")}</div>`;
};

const renderStorePaths = (parsed: ParsedDiff): string => {
  if (!parsed.oldPath && !parsed.newPath) return "";
  const rows: string[] = [];
  if (parsed.oldPath) {
    rows.push(`<dt>Base store path</dt><dd><code>${escapeHtml(parsed.oldPath)}</code></dd>`);
  }
  if (parsed.newPath) {
    rows.push(`<dt>PR store path</dt><dd><code>${escapeHtml(parsed.newPath)}</code></dd>`);
  }
  return `<dl class="store-paths">${rows.join("")}</dl>`;
};

type PreparedResult = {
  result: DiffResult;
  parsed: ParsedDiff;
  anchor: string;
};

const prepare = (results: readonly DiffResult[]): readonly PreparedResult[] =>
  results.map((result, index) => ({
    result,
    parsed: parseDiff(result.diff),
    anchor: `diff-${index}-${slugify(result.displayName)}`,
  }));

const renderSection = ({ result, parsed, anchor }: PreparedResult): string => {
  // The Raw dix output already contains every unparsed line, so we don't render
  // a separate Unparsed block — it would just duplicate bytes in the artifact.
  const rawBlock = `<details class="raw-block"><summary>Raw dix output</summary><pre><code>${escapeHtml(result.diff)}</code></pre></details>`;

  return `
    <article class="diff-card" id="${escapeHtml(anchor)}">
      <header class="diff-card-header">
        <h2>${escapeHtml(result.displayName)}</h2>
        <dl class="diff-meta">
          <dt>Attribute</dt>
          <dd><code>${escapeHtml(result.attributePath)}</code></dd>
          <dt>Base</dt>
          <dd><code>${escapeHtml(result.baseRef)}</code></dd>
          <dt>PR</dt>
          <dd><code>${escapeHtml(result.prRef)}</code></dd>
        </dl>
      </header>
      <div class="diff-card-body">
        ${renderStats(parsed)}
        ${renderStorePaths(parsed)}
        ${renderNoChanges(parsed)}
        ${renderChangeSection("changed", "CHANGED", parsed.changed)}
        ${renderChangeSection("added", "ADDED", parsed.added)}
        ${renderChangeSection("removed", "REMOVED", parsed.removed)}
        ${rawBlock}
      </div>
    </article>`;
};

const renderSummary = (prepared: readonly PreparedResult[]): string => {
  if (prepared.length === 0) return "";
  const rows = prepared
    .map(({ result, parsed, anchor }) => {
      const sizeCell =
        parsed.sizeBefore && parsed.sizeAfter
          ? `<code>${escapeHtml(parsed.sizeBefore)}</code> <span class="arrow">→</span> <code>${escapeHtml(parsed.sizeAfter)}</code>`
          : `<span class="muted">—</span>`;
      return `
        <tr>
          <td><a href="#${escapeHtml(anchor)}">${escapeHtml(result.displayName)}</a></td>
          <td><code>${escapeHtml(result.attributePath)}</code></td>
          <td class="num stat-added">${parsed.added.length}</td>
          <td class="num stat-removed">${parsed.removed.length}</td>
          <td class="num stat-changed">${parsed.changed.length}</td>
          <td>${sizeCell}</td>
        </tr>`;
    })
    .join("");
  return `
    <section class="summary">
      <h2>Summary</h2>
      <table class="summary-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Attribute</th>
            <th class="num">+</th>
            <th class="num">−</th>
            <th class="num">Δ</th>
            <th>Closure size</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
};

export const generateDiffHtml = (results: readonly DiffResult[]): string => {
  const prepared = prepare(results);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nix Diff Results</title>
  <style>${diffHtmlStyles}</style>
</head>
<body>
  <div class="page-header">
    <h1>Nix Diff Results</h1>
    <p>${prepared.length} ${prepared.length === 1 ? "comparison" : "comparisons"}</p>
  </div>
${renderSummary(prepared)}
${prepared.map(renderSection).join("\n")}
  <footer>Generated by <a href="https://github.com/natsukium/nix-diff-action">nix-diff-action</a> · diff engine: <a href="https://github.com/manic-systems/dix">dix</a></footer>
</body>
</html>`;
};
