import * as github from "@actions/github";
import { Effect, Option } from "effect";
import { NotPullRequestContextError, GitHubApiError } from "../errors.js";
import type { GitHubContext, Octokit, PullRequestPayload, CommentOptions } from "../types.js";
import type { DiffResult } from "../schemas.js";
import { hasDixChanges } from "./utils.js";
import {
  countExplicit,
  isUnchanged,
  pluralize,
  selectionNote,
  viewFromReport,
  type DiffView,
  type PackageRow,
} from "./view.js";

const NIX_DIFF_ACTION_MARKER_BASE = "<!-- nix-diff-action";

// Generate marker for identifying nix-diff-action comments
//
// Why single vs multiple attribute matters:
// - Single attribute: Use displayName-specific marker (<!-- nix-diff-action:host1 -->)
//   This enables matrix strategy where each job posts its own comment with `comment-strategy: update`.
//   Each comment can be updated independently without affecting others.
//
// - Multiple attributes: Use generic marker (<!-- nix-diff-action -->)
//   Results order may vary (e.g., comment-only mode downloads artifacts in parallel),
//   so we can't reliably use a specific displayName. Generic marker ensures
//   the aggregated comment is always found and updated correctly.
const getNixDiffActionMarker = (displayName?: string): string =>
  displayName
    ? `${NIX_DIFF_ACTION_MARKER_BASE}:${displayName} -->`
    : `${NIX_DIFF_ACTION_MARKER_BASE} -->`;

// GitHub comment size limit is ~65,536 characters. Use a conservative limit.
const MAX_COMMENT_LENGTH = 60000;

export type TruncateResult = {
  text: string;
  truncated: boolean;
};

export const truncateDiff = (diff: string, maxLength: number): TruncateResult => {
  if (diff.length <= maxLength) return { text: diff, truncated: false };
  return {
    text: `${diff.slice(0, maxLength)}\n\n... (truncated, ${diff.length} chars total)`,
    truncated: true,
  };
};

// Remove markdown special characters to prevent formatting disruption
// Preserves Unicode letters (日本語 etc.), numbers, hyphens, dots, and spaces
export const sanitizeDisplayName = (text: string): string =>
  text.replace(/[\\`*_{}[\]()#+!|]/g, "");

// Inside a GFM table a pipe ends the cell even within a code span, and a
// backtick would close the span early.
const codeCell = (text: string): string =>
  text ? `\`${text.replace(/`/g, "'").replace(/\|/g, "\\|")}\`` : "";

const renderStatsTable = (view: DiffView): string => {
  const rows: string[] = [];
  if (view.size) {
    rows.push(
      `| Closure size | ${codeCell(view.size.before)} | ${codeCell(view.size.after)} | ${codeCell(view.size.delta ?? "")} |`,
    );
  }
  if (view.paths) {
    rows.push(
      `| Store paths | ${view.paths.old} | ${view.paths.new} | +${view.paths.added} / −${view.paths.removed} |`,
    );
  }
  if (rows.length === 0) return "";
  return ["|  | Base | PR | Diff |", "| --- | ---: | ---: | ---: |", ...rows].join("\n");
};

const nameCell = (row: PackageRow, withNote: boolean): string => {
  if (!row.selection) return codeCell(row.name);
  const note = withNote ? selectionNote(row) : undefined;
  return `**${codeCell(row.name)}**${note ? ` <sub>${note}</sub>` : ""}`;
};

const SELECTION_LEGEND =
  "<sub>**Bold**: packages listed explicitly in `environment.systemPackages` of the base or the PR.</sub>";

type RenderedBody = { text: string; truncated: boolean };

const COMMENT_MAX_VERSIONS = 5;

const TABLE_HEADER = "| Package | Version | Size |\n| --- | --- | ---: |";

// Each group gets an equal share of the budget, and what a group leaves
// unused passes to the next one; filling groups in order would let a long
// Changed list crowd out Added and Removed entirely.
const renderPackageTables = (view: DiffView, budget: number): RenderedBody => {
  const groups = [
    { label: "Changed", rows: view.changed, notes: true },
    { label: "Added", rows: view.added, notes: false },
    { label: "Removed", rows: view.removed, notes: false },
  ].filter((g) => g.rows.length > 0);

  const parts: string[] = [];
  let remaining = budget;
  let truncated = false;
  groups.forEach((group, index) => {
    const share = Math.floor(remaining / (groups.length - index));
    const lines: string[] = [];
    let used = TABLE_HEADER.length;
    for (const row of group.rows) {
      const line = `| ${nameCell(row, group.notes)} | ${codeCell(row.version)} | ${row.sizeDelta ?? ""} |`;
      if (used + line.length + 1 > share) break;
      lines.push(line);
      used += line.length + 1;
    }
    const omitted = group.rows.length - lines.length;
    if (lines.length > 0) remaining -= used;
    if (omitted > 0) truncated = true;
    const table = lines.length > 0 ? `\n\n${TABLE_HEADER}\n${lines.join("\n")}` : "";
    const note =
      omitted > 0
        ? `\n\n> **Note**: ${pluralize(omitted, "more package")} not shown. See the full output in the artifacts below.`
        : "";
    const explicitCount = countExplicit(group.rows);
    const count =
      explicitCount > 0
        ? `${group.rows.length}, ${explicitCount} explicit`
        : `${group.rows.length}`;
    parts.push(`<details>
<summary>${group.label} (${count})</summary>${table}${note}

</details>`);
  });
  return { text: parts.join("\n\n"), truncated };
};

const renderReportBody = (view: DiffView, budget: number): RenderedBody => {
  const stats = renderStatsTable(view);
  const hidden =
    view.hiddenCount > 0
      ? `\n\n<sub>${pluralize(view.hiddenCount, "package")} with only a minor size change hidden.</sub>`
      : "";

  if (isUnchanged(view)) {
    return {
      text:
        [stats, "No package additions, removals, or version changes."]
          .filter(Boolean)
          .join("\n\n") + hidden,
      truncated: false,
    };
  }

  const tables = renderPackageTables(view, budget);
  return {
    text: `${stats ? `${stats}\n\n` : ""}${view.hasSelection ? `${SELECTION_LEGEND}\n\n` : ""}${tables.text}${hidden}`,
    truncated: tables.truncated,
  };
};

// dix < 2.0 has no JSON output, so its text is shown verbatim.
const renderTextBody = (text: string, budget: number): RenderedBody => {
  const truncated = truncateDiff(text || "No differences found", budget);
  const hint = truncated.truncated
    ? "\n\n> **Note**: Diff was truncated. See the full output in the artifacts below."
    : "";
  return {
    text: `<details>
<summary>Diff Output</summary>

\`\`\`
${truncated.text}
\`\`\`
${hint}
</details>`,
    truncated: truncated.truncated,
  };
};

const renderResultBody = (result: DiffResult, budget: number): RenderedBody =>
  result.diff.format === "json"
    ? renderReportBody(
        viewFromReport(result.diff.report, { maxVersions: COMMENT_MAX_VERSIONS }),
        budget,
      )
    : renderTextBody(result.diff.text, budget);

export type FormatCommentOptions = {
  repoUrl: string;
  runId?: string;
  // Whether the HTML viewer artifact was uploaded successfully. When false,
  // the "View diff as HTML" link is omitted to avoid linking to a 404.
  htmlViewerAvailable?: boolean;
};

const renderSection = (result: DiffResult, budget: number): string =>
  `### ${sanitizeDisplayName(result.displayName)}

**Attribute**: \`${result.attributePath}\`

${renderResultBody(result, budget).text}`;

export const formatAggregatedComment = (
  results: readonly DiffResult[],
  headSha: string,
  options?: FormatCommentOptions,
): string => {
  // Single attribute: displayName-specific marker for matrix + update strategy
  // Multiple attributes: generic marker (results order may vary in comment-only mode)
  const marker =
    results.length === 1
      ? getNixDiffActionMarker(results[0].displayName)
      : getNixDiffActionMarker();

  // Format compare link once for the entire comment
  const compareDisplay = options
    ? `[Compare changes](${options.repoUrl}/compare/${results[0].baseRef}...${results[0].prRef})`
    : `\`${results[0].baseRef}...${results[0].prRef}\``;

  // Skip the viewer link when the HTML artifact was not uploaded (either no
  // results or upload failure), otherwise the link would 404.
  const htmlViewerLink =
    options?.runId && results.length > 0 && options.htmlViewerAvailable
      ? `\n> :page_facing_up: [View diff as HTML](${options.repoUrl}/actions/runs/${options.runId}) in the Artifacts section\n`
      : "";

  const footer = `---
<sub>Generated by [nix-diff-action](https://github.com/natsukium/nix-diff-action) using [dix](https://github.com/manic-systems/dix)</sub>
<!-- nix-diff-action-footer sha=${headSha} -->`;

  const wrap = (sections: string) => `${marker}
## Nix Diff

${compareDisplay}

${sections}
${htmlViewerLink}
${footer}`;

  // A fixed per-section allowance for markup can overflow the limit, so the
  // markup is measured by rendering each section with a zero budget, and only
  // the remainder is shared out to package rows. Trailing sections whose
  // markup alone would overflow are dropped behind a notice.
  const omittedNotice = (count: number) =>
    `\n\n> **Note**: ${pluralize(count, "more attribute")} not shown. See the full output in the artifacts below.`;
  let fixedLength = wrap("").length;
  let shown = 0;
  for (const result of results) {
    const length = renderSection(result, 0).length + 2;
    const remaining = results.length - shown - 1;
    const notice = remaining > 0 ? omittedNotice(remaining).length : 0;
    if (shown > 0 && fixedLength + length + notice > MAX_COMMENT_LENGTH) break;
    fixedLength += length;
    shown++;
  }
  const kept = results.slice(0, shown);
  const omitted = results.length - shown;
  if (omitted > 0) fixedLength += omittedNotice(omitted).length;

  const budget = Math.max(0, Math.floor((MAX_COMMENT_LENGTH - fixedLength) / Math.max(1, shown)));

  return wrap(
    kept.map((result) => renderSection(result, budget)).join("\n\n") +
      (omitted > 0 ? omittedNotice(omitted) : ""),
  );
};

// Common: list all comments with nix-diff-action marker
// If displayName is provided, search for displayName-specific marker
const listNixDiffComments = (
  octokit: Octokit,
  context: GitHubContext,
  prNumber: number,
  displayName?: string,
) =>
  Effect.tryPromise({
    try: () =>
      octokit.paginate(octokit.rest.issues.listComments, {
        ...context.repo,
        issue_number: prNumber,
      }),
    catch: (e) =>
      new GitHubApiError({
        operation: "listComments",
        message: `Failed to list comments: ${e}`,
      }),
  }).pipe(
    Effect.map((comments) => {
      const marker = getNixDiffActionMarker(displayName);
      return comments.filter((c) => c.body?.includes(marker));
    }),
  );

const findExistingNixDiffComment = (
  octokit: Octokit,
  context: GitHubContext,
  prNumber: number,
  displayName?: string,
): Effect.Effect<Option.Option<{ id: number }>, GitHubApiError> =>
  listNixDiffComments(octokit, context, prNumber, displayName).pipe(
    Effect.map((comments) => Option.fromNullable(comments[0])),
    Effect.map(Option.map((c) => ({ id: c.id }))),
  );

const findOldNixDiffComments = (
  octokit: Octokit,
  context: GitHubContext,
  prNumber: number,
  currentHeadSha: string,
  displayName?: string,
): Effect.Effect<Array<{ id: number; node_id: string }>, GitHubApiError> =>
  listNixDiffComments(octokit, context, prNumber, displayName).pipe(
    Effect.map((comments) =>
      comments
        .filter((c) => !c.body?.includes(`sha=${currentHeadSha}`))
        .map((c) => ({ id: c.id, node_id: c.node_id })),
    ),
  );

const minimizeOldComments = (
  octokit: Octokit,
  context: GitHubContext,
  prNumber: number,
  currentHeadSha: string,
  displayName?: string,
): Effect.Effect<void, GitHubApiError> =>
  findOldNixDiffComments(octokit, context, prNumber, currentHeadSha, displayName).pipe(
    Effect.flatMap((oldComments) =>
      Effect.forEach(
        oldComments,
        (comment) =>
          Effect.tryPromise({
            try: () =>
              octokit.graphql(
                `
                mutation($input: MinimizeCommentInput!) {
                  minimizeComment(input: $input) {
                    minimizedComment {
                      isMinimized
                    }
                  }
                }
                `,
                {
                  input: {
                    subjectId: comment.node_id,
                    classifier: "OUTDATED",
                  },
                },
              ),
            catch: (e) =>
              new GitHubApiError({
                operation: "minimizeComment",
                message: `Failed to minimize comment ${comment.id}: ${e}`,
              }),
          }).pipe(
            Effect.flatMap(() => Effect.logInfo(`Minimized outdated comment (ID: ${comment.id})`)),
            Effect.catchAll((error) =>
              Effect.logWarning(`Failed to minimize comment ${comment.id}: ${error.message}`),
            ),
          ),
        { concurrency: "unbounded" },
      ),
    ),
  );

const updateComment = (octokit: Octokit, context: GitHubContext, commentId: number, body: string) =>
  Effect.tryPromise({
    try: () =>
      octokit.rest.issues.updateComment({
        ...context.repo,
        comment_id: commentId,
        body,
      }),
    catch: (e) =>
      new GitHubApiError({
        operation: "updateComment",
        message: `Failed to update comment: ${e}`,
      }),
  });

const createComment = (octokit: Octokit, context: GitHubContext, prNumber: number, body: string) =>
  Effect.tryPromise({
    try: () =>
      octokit.rest.issues.createComment({
        ...context.repo,
        issue_number: prNumber,
        body,
      }),
    catch: (e) =>
      new GitHubApiError({
        operation: "createComment",
        message: `Failed to create comment: ${e}`,
      }),
  });

export class GitHubService extends Effect.Service<GitHubService>()("GitHubService", {
  succeed: {
    getContext: (): GitHubContext => github.context,

    getPullRequest: (): Effect.Effect<PullRequestPayload, NotPullRequestContextError> =>
      Effect.gen(function* () {
        const pr = github.context.payload.pull_request;
        if (!pr) {
          return yield* Effect.fail(
            new NotPullRequestContextError({
              message: "This action must be run in a pull request context",
            }),
          );
        }
        return pr as PullRequestPayload;
      }),

    createOctokit: (token: string): Octokit => github.getOctokit(token),

    postAggregatedComment: (
      octokit: Octokit,
      context: GitHubContext,
      pr: PullRequestPayload,
      results: readonly DiffResult[],
      options: CommentOptions,
      formatOptions?: FormatCommentOptions,
    ): Effect.Effect<void, GitHubApiError> =>
      Effect.gen(function* () {
        const hasChanges = results.some((r) => hasDixChanges(r));
        const commentBody = formatAggregatedComment(results, pr.head.sha, formatOptions);
        // Use displayName-specific marker for single attribute
        const displayName = results.length === 1 ? results[0].displayName : undefined;

        if (options.skipNoChange && !hasChanges) {
          return yield* Effect.logInfo(
            "No differences found. Skipping comment (skip-no-change is enabled).",
          );
        }

        if (options.commentStrategy === "update") {
          const existing = yield* findExistingNixDiffComment(
            octokit,
            context,
            pr.number,
            displayName,
          );
          return yield* Option.match(existing, {
            onNone: () =>
              Effect.gen(function* () {
                yield* createComment(octokit, context, pr.number, commentBody);
                yield* Effect.logInfo("Posted new aggregated diff comment to PR");
              }),
            onSome: (e) =>
              Effect.gen(function* () {
                yield* updateComment(octokit, context, e.id, commentBody);
                yield* Effect.logInfo("Updated existing diff comment");
              }),
          });
        }

        if (options.commentStrategy === "create") {
          yield* minimizeOldComments(octokit, context, pr.number, pr.head.sha, displayName);
        }
        yield* createComment(octokit, context, pr.number, commentBody);
        yield* Effect.logInfo("Posted new aggregated diff comment to PR");
      }),
  },
}) {}
