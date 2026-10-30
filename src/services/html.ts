import type { DiffResult } from "../schemas.js";
import {
  countExplicit,
  isUnchanged,
  pluralize,
  selectionNote,
  toView,
  type DiffView,
  type PackageRow,
} from "./view.js";
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

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "diff";

const renderEntryRows = (rows: readonly PackageRow[], withNotes: boolean): string =>
  rows
    .map((row) => {
      const note = withNotes ? selectionNote(row) : undefined;
      const noteHtml = note ? ` <span class="selection-note">${note}</span>` : "";
      const rowClass = row.selection ? ` class="pkg-selected"` : "";
      return `<tr${rowClass}><td class="pkg-name"><code>${escapeHtml(row.name)}</code>${noteHtml}</td><td class="pkg-ver"><code>${escapeHtml(row.version)}</code></td><td class="pkg-size">${row.sizeDelta ? `<code>${escapeHtml(row.sizeDelta)}</code>` : ""}</td></tr>`;
    })
    .join("");

const renderChangeSection = (
  kind: "added" | "removed" | "changed",
  label: string,
  rows: readonly PackageRow[],
): string => {
  if (rows.length === 0) return "";
  const explicitCount = countExplicit(rows);
  const count = explicitCount > 0 ? `${rows.length} · ${explicitCount} explicit` : `${rows.length}`;
  return `
      <details open class="change-group change-${kind}">
        <summary class="change-heading">
          <span class="change-badge">${label}</span>
          <span class="change-count">${count}</span>
        </summary>
        <table class="change-table">
          <tbody>${renderEntryRows(rows, kind === "changed")}</tbody>
        </table>
      </details>`;
};

const renderSelectionLegend = (view: DiffView): string =>
  view.hasSelection
    ? `<p class="muted"><strong>Bold</strong>: packages listed explicitly in <code>environment.systemPackages</code> of the base or the PR.</p>`
    : "";

const renderNoChanges = (view: DiffView): string =>
  isUnchanged(view)
    ? `<p class="no-changes">No package additions, removals, or version changes.</p>`
    : "";

const renderHidden = (view: DiffView): string =>
  view.hiddenCount > 0
    ? `<p class="muted">${pluralize(view.hiddenCount, "package")} with only a minor size change hidden.</p>`
    : "";

const renderStats = (view: DiffView): string => {
  const stats: string[] = [];
  if (view.size) {
    stats.push(
      `<div class="stat"><span class="stat-label">Closure size</span><span class="stat-value"><code>${escapeHtml(view.size.before)}</code> <span class="arrow">→</span> <code>${escapeHtml(view.size.after)}</code></span></div>`,
    );
    if (view.size.delta) {
      stats.push(
        `<div class="stat"><span class="stat-label">Diff size</span><span class="stat-value"><code>${escapeHtml(view.size.delta)}</code></span></div>`,
      );
    }
  }
  if (view.paths) {
    stats.push(
      `<div class="stat"><span class="stat-label">Store paths</span><span class="stat-value"><code>${view.paths.old}</code> <span class="arrow">→</span> <code>${view.paths.new}</code></span></div>`,
    );
  }
  // The no-changes banner already says "nothing added/removed/changed", so skip
  // the three zero-valued chips to avoid visual noise.
  if (!isUnchanged(view)) {
    stats.push(
      `<div class="stat"><span class="stat-label">Added</span><span class="stat-value stat-added">${view.added.length}</span></div>`,
    );
    stats.push(
      `<div class="stat"><span class="stat-label">Removed</span><span class="stat-value stat-removed">${view.removed.length}</span></div>`,
    );
    stats.push(
      `<div class="stat"><span class="stat-label">Changed</span><span class="stat-value stat-changed">${view.changed.length}</span></div>`,
    );
  }
  if (stats.length === 0) return "";
  return `<div class="stats">${stats.join("")}</div>`;
};

const renderStorePaths = (result: DiffResult): string =>
  `<dl class="store-paths"><dt>Base store path</dt><dd><code>${escapeHtml(result.basePath)}</code></dd><dt>PR store path</dt><dd><code>${escapeHtml(result.prPath)}</code></dd></dl>`;

const rawOutput = (result: DiffResult): string =>
  result.diff.format === "json" ? JSON.stringify(result.diff.report, null, 2) : result.diff.text;

type PreparedResult = {
  result: DiffResult;
  view: DiffView;
  anchor: string;
};

const prepare = (results: readonly DiffResult[]): readonly PreparedResult[] =>
  results.map((result, index) => ({
    result,
    view: toView(result.diff),
    anchor: `diff-${index}-${slugify(result.displayName)}`,
  }));

const renderSection = ({ result, view, anchor }: PreparedResult): string => {
  const rawBlock = `<details class="raw-block"><summary>Raw dix output</summary><pre><code>${escapeHtml(rawOutput(result))}</code></pre></details>`;

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
        ${renderStats(view)}
        ${renderStorePaths(result)}
        ${renderNoChanges(view)}
        ${renderSelectionLegend(view)}
        ${renderChangeSection("changed", "CHANGED", view.changed)}
        ${renderChangeSection("added", "ADDED", view.added)}
        ${renderChangeSection("removed", "REMOVED", view.removed)}
        ${renderHidden(view)}
        ${rawBlock}
      </div>
    </article>`;
};

const renderSummary = (prepared: readonly PreparedResult[]): string => {
  if (prepared.length === 0) return "";
  const rows = prepared
    .map(({ result, view, anchor }) => {
      const sizeCell = view.size
        ? `<code>${escapeHtml(view.size.before)}</code> <span class="arrow">→</span> <code>${escapeHtml(view.size.after)}</code>`
        : `<span class="muted">—</span>`;
      return `
        <tr>
          <td><a href="#${escapeHtml(anchor)}">${escapeHtml(result.displayName)}</a></td>
          <td><code>${escapeHtml(result.attributePath)}</code></td>
          <td class="num stat-added">${view.added.length}</td>
          <td class="num stat-removed">${view.removed.length}</td>
          <td class="num stat-changed">${view.changed.length}</td>
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
