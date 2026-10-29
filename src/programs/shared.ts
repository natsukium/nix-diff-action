import * as core from "@actions/core";
import * as crypto from "crypto";
import { Effect, Option, Redacted } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { GitService, NixService, GitHubService } from "../services/index.js";
import { hasDixChanges } from "../services/utils.js";
import type { NixOutputConfig, DiffResult } from "../schemas.js";
import {
  MissingAttributesError,
  NotPullRequestContextError,
  AttributeParseError,
  InvalidDirectoryError,
  GitWorktreeError,
  NixPathInfoError,
  NixBuildError,
  NixDixError,
  GitHubApiError,
  InvalidCommentStrategyError,
} from "../errors.js";
import type { CommentStrategy } from "../types.js";
import { parseAttributes, validateDirectory, parseCommentStrategy } from "./index.js";
import { ActionConfig } from "../config.js";
import { processDiffResults } from "./full.js";

// ============================================================
// Common helpers extracted from full.ts and comment.ts
// ============================================================

/**
 * Get GitHub token from config (redacted for security)
 * Used by: runFull, runComment
 */
export const getGithubToken = Effect.gen(function* () {
  const redactedToken = yield* ActionConfig.githubToken;
  return Redacted.value(redactedToken);
});

/**
 * Get attributes input with required validation
 * Used by: runFull, runDiff
 */
export const getAttributesInput = ActionConfig.attributes.pipe(
  Effect.mapError(
    () =>
      new MissingAttributesError({
        message: "attributes input is required",
      }),
  ),
);

/**
 * Set diff output as GitHub Actions output
 * Used by: runFull, runDiff
 */
export const setDiffOutput = (results: readonly DiffResult[]): void => {
  if (results.length > 0) {
    const diffOutputs = results.map((r) => ({
      displayName: r.displayName,
      attributePath: r.attributePath,
      basePath: r.basePath,
      prPath: r.prPath,
      hasChanges: hasDixChanges(r),
      ...r.diff,
    }));
    core.setOutput("diff", JSON.stringify(diffOutputs));
  }
};

// ============================================================
// Diff pipeline configuration (Phase 3)
// ============================================================

export type DiffPipelineConfig = {
  attributes: readonly NixOutputConfig[];
  directory: string;
  build: boolean;
  runId: string;
  githubRunId: Option.Option<string>;
  cwd: string;
};

export type LoadDiffPipelineConfigError =
  | MissingAttributesError
  | AttributeParseError
  | InvalidDirectoryError
  | ConfigError;

/**
 * Load and parse common configuration for diff pipeline
 * Used by: runFull, runDiff
 */
export const loadDiffPipelineConfig: Effect.Effect<
  DiffPipelineConfig,
  LoadDiffPipelineConfigError
> = Effect.gen(function* () {
  const attributesInput = yield* getAttributesInput;
  const directoryInput = yield* ActionConfig.directory;
  const build = yield* ActionConfig.build;
  const githubRunId = yield* ActionConfig.githubRunId;
  const runId = Option.getOrElse(githubRunId, () => crypto.randomUUID());
  const cwd = yield* Effect.sync(() => process.cwd());

  const attributes = yield* parseAttributes(attributesInput);
  const directory = yield* validateDirectory(directoryInput, cwd);

  return { attributes, directory, build, runId, githubRunId, cwd };
});

export type RunDiffPipelineError =
  | LoadDiffPipelineConfigError
  | NotPullRequestContextError
  | GitWorktreeError
  | NixPathInfoError
  | NixBuildError
  | NixDixError;

/**
 * Execute diff pipeline and return results
 * Used by: runFull, runDiff
 */
export const runDiffPipeline: Effect.Effect<
  { config: DiffPipelineConfig; results: readonly DiffResult[] },
  RunDiffPipelineError,
  GitService | NixService | GitHubService
> = Effect.gen(function* () {
  const githubService = yield* GitHubService;
  const pr = yield* githubService.getPullRequest();
  const config = yield* loadDiffPipelineConfig;

  const results = yield* Effect.scoped(
    processDiffResults({
      attributes: config.attributes,
      build: config.build,
      directory: config.directory,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      cwd: config.cwd,
      runId: config.runId,
    }),
  );

  return { config, results };
});

// ============================================================
// Comment posting logic (Phase 4)
// ============================================================

export type PostCommentParams = {
  results: readonly DiffResult[];
  runId?: string;
  skipNoChange: boolean;
  commentStrategy: CommentStrategy;
  token: string;
  // Whether the HTML viewer artifact is actually present in the run's artifacts.
  // Controls whether the "View diff as HTML" link is included in the comment.
  htmlViewerAvailable: boolean;
};

/**
 * Post aggregated comment to PR
 * Used by: runFull, runComment
 */
export const postComment = (
  params: PostCommentParams,
): Effect.Effect<void, GitHubApiError | NotPullRequestContextError, GitHubService> =>
  Effect.gen(function* () {
    const githubService = yield* GitHubService;
    const context = githubService.getContext();
    const pr = yield* githubService.getPullRequest();

    const repoUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}`;

    yield* githubService.postAggregatedComment(
      githubService.createOctokit(params.token),
      context,
      pr,
      params.results,
      { skipNoChange: params.skipNoChange, commentStrategy: params.commentStrategy },
      {
        repoUrl,
        runId: params.runId,
        htmlViewerAvailable: params.htmlViewerAvailable,
      },
    );
  });

// ============================================================
// Comment configuration loading
// ============================================================

export type CommentConfig = {
  skipNoChange: boolean;
  commentStrategy: CommentStrategy;
};

export type LoadCommentConfigError = InvalidCommentStrategyError | ConfigError;

/**
 * Load comment-related configuration
 * Used by: runFull, runComment
 */
export const loadCommentConfig: Effect.Effect<CommentConfig, LoadCommentConfigError> = Effect.gen(
  function* () {
    const skipNoChange = yield* ActionConfig.skipNoChange;
    const commentStrategyInput = yield* ActionConfig.commentStrategy;
    const commentStrategy = yield* parseCommentStrategy(commentStrategyInput);

    return { skipNoChange, commentStrategy };
  },
);
