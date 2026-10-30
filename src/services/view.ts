import type { DixOutput, DixPackageDiff, DixReport } from "../schemas.js";

// Whether a package is listed explicitly, as dix reports for `system-path`.
// Absent when it is a dependency on both sides.
export type Selection = "selected" | "newly-selected" | "newly-unselected";

export type PackageRow = {
  name: string;
  version: string;
  sizeDelta?: string;
  selection?: Selection;
};

export type DiffView = {
  changed: PackageRow[];
  added: PackageRow[];
  removed: PackageRow[];
  // Packages whose versions did not change and whose size changed by less
  // than MIN_SIZE_DELTA.
  hiddenCount: number;
  // dix only finds explicit packages in a built system profile, so this is
  // false for every other diff.
  hasSelection: boolean;
  size?: { before: string; after: string; delta?: string };
  paths?: DixReport["paths"];
};

// Same threshold dix 3 applies to its human output by default
// (`--min-size-delta 1MiB`), so the comment hides what dix itself would hide.
const MIN_SIZE_DELTA = 1024 * 1024;

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

export const formatBytes = (bytes: number): string => {
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const sign = bytes < 0 ? "-" : "";
  return unit === 0 ? `${sign}${value} B` : `${sign}${value.toFixed(1)} ${UNITS[unit]}`;
};

export const pluralize = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export const formatSignedBytes = (bytes: number): string =>
  bytes > 0 ? `+${formatBytes(bytes)}` : formatBytes(bytes);

const formatVersion = (name: string | null, amount = 1): string =>
  `${name ?? "<none>"}${amount > 1 ? ` ×${amount}` : ""}`;

const capVersions = (items: string[], max: number): string[] =>
  items.length > max ? [...items.slice(0, max), `+${items.length - max} more`] : items;

const describeVersions = (diff: DixPackageDiff, maxVersions: number): string => {
  let before: string[] = [];
  let after: string[] = [];
  for (const event of diff.versions) {
    switch (event.kind) {
      case "added":
        after.push(formatVersion(event.version.name, event.version.amount));
        break;
      case "removed":
        before.push(formatVersion(event.version.name, event.version.amount));
        break;
      case "changed":
        before.push(formatVersion(event.old.name, event.old.amount));
        after.push(formatVersion(event.new.name, event.new.amount));
        break;
      case "amount_changed":
        before.push(formatVersion(event.version.name, event.old_amount));
        after.push(formatVersion(event.version.name, event.new_amount));
        break;
    }
  }
  before = capVersions(before, maxVersions);
  after = capVersions(after, maxVersions);
  // `versions` lists only what changed; without this marker a package that
  // also kept other versions would read as if it had only the listed ones.
  if (diff.has_omitted_versions) {
    before.push("<unchanged>");
    after.push("<unchanged>");
  }
  if (diff.status === "Added") return after.join(", ");
  if (diff.status === "Removed") return before.join(", ");
  if (before.length === 0 && after.length === 0) return "";
  return `${before.join(", ") || "∅"} → ${after.join(", ") || "∅"}`;
};

// `selection` stays a plain string in the schema so that a variant added by
// dix is shown as a dependency instead of failing the JSON decode.
const SELECTIONS = new Map<string, Selection>([
  ["Selected", "selected"],
  ["NewlySelected", "newly-selected"],
  ["NewlyUnselected", "newly-unselected"],
]);

// Added and Removed already imply the direction, so only a Changed row needs
// to say how its selection moved.
export const selectionNote = (row: PackageRow): string | undefined =>
  row.selection === "newly-selected"
    ? "now explicit"
    : row.selection === "newly-unselected"
      ? "now a dependency only"
      : undefined;

export const countExplicit = (rows: readonly PackageRow[]): number =>
  rows.filter((row) => row.selection).length;

// Comment truncation drops rows from the end of each group, so listing
// explicit packages first keeps them visible in large diffs.
const explicitFirst = (rows: PackageRow[]): PackageRow[] => [
  ...rows.filter((row) => row.selection),
  ...rows.filter((row) => !row.selection),
];

// maxVersions caps the versions listed per side, for packages such as patch
// collections whose version lists would otherwise fill the PR comment.
export const viewFromReport = (
  report: DixReport,
  { maxVersions = Infinity }: { maxVersions?: number } = {},
): DiffView => {
  const view: DiffView = {
    changed: [],
    added: [],
    removed: [],
    hiddenCount: 0,
    hasSelection: false,
    size: {
      before: formatBytes(report.size_old),
      after: formatBytes(report.size_new),
      delta: formatSignedBytes(report.size_new - report.size_old),
    },
    paths: report.paths,
  };
  for (const diff of report.diffs) {
    // dix 2 has no `kind` field, so derive dix 3's ChangeKind::Version here.
    const versionChanged = diff.versions.some((event) => event.kind !== "amount_changed");
    if (!versionChanged && Math.abs(diff.size_delta) < MIN_SIZE_DELTA) {
      view.hiddenCount++;
      continue;
    }
    const row: PackageRow = {
      name: diff.name,
      version: describeVersions(diff, maxVersions),
      sizeDelta: diff.size_delta !== 0 ? formatSignedBytes(diff.size_delta) : undefined,
    };
    const selection = SELECTIONS.get(diff.selection);
    if (selection) {
      row.selection = selection;
      view.hasSelection = true;
    }
    if (diff.status === "Added") view.added.push(row);
    else if (diff.status === "Removed") view.removed.push(row);
    else view.changed.push(row);
  }
  view.changed = explicitFirst(view.changed);
  view.added = explicitFirst(view.added);
  view.removed = explicitFirst(view.removed);
  return view;
};

// dix prefixes entries like "[A.] pkgname   1.2.3". The bracketed marker is
// currently 2 chars in dix but we allow {1,4} so format tweaks don't silently
// break stripping — the surrounding section already conveys ADDED/REMOVED/CHANGED.
export const stripPrefix = (line: string): string => line.replace(/^\[[A-Za-z.*+-]{1,4}\]\s*/, "");

const rowFromLine = (line: string): PackageRow => {
  const stripped = stripPrefix(line);
  // dix aligns name/version with whitespace; split on 2+ spaces to get two
  // columns when possible, otherwise keep the whole line as the name.
  const match = /^(\S+)\s{2,}(.+)$/.exec(stripped);
  return match ? { name: match[1], version: match[2] } : { name: stripped, version: "" };
};

// Best-effort parser for the human-readable output of dix < 2.0, which has no
// JSON mode. Lines outside a section are ignored; the raw output is still
// shown verbatim alongside the parsed view.
export const viewFromText = (text: string): DiffView => {
  const view: DiffView = {
    changed: [],
    added: [],
    removed: [],
    hiddenCount: 0,
    hasSelection: false,
  };
  let section: "added" | "removed" | "changed" | null = null;
  let sizeBefore: string | undefined;
  let sizeAfter: string | undefined;
  let diffSize: string | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) {
      section = null;
      continue;
    }
    const heading = /^(ADDED|REMOVED|CHANGED)(\s+\(\d+\))?$/.exec(line);
    if (heading) {
      section = heading[1].toLowerCase() as "added" | "removed" | "changed";
      continue;
    }
    const size = /^SIZE:\s*(.+?)\s*(?:->|→)\s*(.+)$/.exec(line);
    if (size) {
      sizeBefore = size[1];
      sizeAfter = size[2];
      section = null;
      continue;
    }
    const delta = /^DIFF:\s*(.+)$/.exec(line);
    if (delta) {
      diffSize = delta[1];
      section = null;
      continue;
    }
    if (section) view[section].push(rowFromLine(line));
  }
  if (sizeBefore && sizeAfter) {
    view.size = { before: sizeBefore, after: sizeAfter, delta: diffSize };
  }
  return view;
};

export const toView = (output: DixOutput): DiffView =>
  output.format === "json" ? viewFromReport(output.report) : viewFromText(output.text);

export const isUnchanged = (view: DiffView): boolean =>
  view.added.length === 0 && view.removed.length === 0 && view.changed.length === 0;
