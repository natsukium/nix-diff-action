import * as nodePath from "path";
import { Effect, Option, Scope } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { GitService, NixService, GitHubService, ArtifactService } from "../services/index.js";
import { NixOutputConfig, DiffResult } from "../schemas.js";
import {
  GitWorktreeError,
  NixPathInfoError,
  NixDixError,
  NotPullRequestContextError,
  GitHubApiError,
  AttributeParseError,
  InvalidCommentStrategyError,
  InvalidDirectoryError,
  MissingAttributesError,
  ArtifactError,
} from "../errors.js";
import {
  getGithubToken,
  runDiffPipeline,
  loadCommentConfig,
  postComment,
  setDiffOutput,
} from "./shared.js";

// Error type aliases for better readability
type DiffError = NixPathInfoError | NixDixError;
type ProcessDiffError = GitWorktreeError | DiffError;
export type RunFullError =
  | NotPullRequestContextError
  | MissingAttributesError
  | AttributeParseError
  | InvalidCommentStrategyError
  | InvalidDirectoryError
  | ProcessDiffError
  | GitHubApiError
  | ArtifactError
  | ConfigError;

type ProcessDiffOptions = {
  attributes: readonly NixOutputConfig[];
  build: boolean;
  directory: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  cwd: string;
  runId: string;
};

// Service dependency is now hidden - retrieved from context inside Effect.gen
const processNixOutput = (
  config: NixOutputConfig,
  baseFlakeRef: string,
  prFlakeRef: string,
  baseSha: string,
  headSha: string,
  build: boolean,
  worktreePath: string,
): Effect.Effect<DiffResult, DiffError, NixService> =>
  Effect.gen(function* () {
    const nix = yield* NixService;

    yield* Effect.logInfo(
      `Processing ${config.displayName}: ${baseFlakeRef}#${config.attribute} vs ${prFlakeRef}#${config.attribute}`,
    );

    // Run sequentially to avoid Nix SQLite database lock contention
    const { basePath, prPath } = yield* Effect.all({
      basePath: nix.getNixPath(`${baseFlakeRef}#${config.attribute}`, build),
      prPath: nix.getNixPath(`${prFlakeRef}#${config.attribute}`, build),
    });

    yield* Effect.logInfo(`Base path: ${basePath}`);
    yield* Effect.logInfo(`PR path: ${prPath}`);

    const diff = yield* nix.getDixDiff(basePath, prPath, worktreePath);

    return {
      displayName: config.displayName,
      attributePath: config.attribute,
      baseRef: baseSha,
      prRef: headSha,
      diff,
    };
  });

export const processDiffResults = (
  options: ProcessDiffOptions,
): Effect.Effect<readonly DiffResult[], ProcessDiffError, GitService | NixService | Scope.Scope> =>
  Effect.gen(function* () {
    const git = yield* GitService;
    const nix = yield* NixService;

    const worktree = yield* git.createWorktree(options.baseRef, options.runId);

    const relativePath = nodePath.relative(options.cwd, options.directory);
    // Use path: to avoid git history requirements
    const baseFlakeRef =
      relativePath === "" || relativePath === "."
        ? `path:${worktree.path}`
        : `path:${worktree.path}?dir=${relativePath}`;
    const prFlakeRef = options.directory;

    yield* Effect.all(
      [nix.prefetchFlakeInputs(baseFlakeRef), nix.prefetchFlakeInputs(prFlakeRef)],
      {
        concurrency: 2,
      },
    );

    return yield* Effect.forEach(options.attributes, (config) =>
      processNixOutput(
        config,
        baseFlakeRef,
        prFlakeRef,
        options.baseSha,
        options.headSha,
        options.build,
        worktree.path,
      ),
    );
  });

export const runFull: Effect.Effect<
  void,
  RunFullError,
  GitService | NixService | GitHubService | ArtifactService
> = Effect.gen(function* () {
  const artifactService = yield* ArtifactService;

  // Load configurations
  const token = yield* getGithubToken;
  const commentConfig = yield* loadCommentConfig;

  // Run diff pipeline
  const { config, results } = yield* runDiffPipeline;

  // Always upload diff results as artifact (JSON format for consistency with diff-only mode)
  yield* artifactService.uploadDiffResults(results, "full");

  // Post comment to PR
  yield* postComment({
    results,
    runId: config.runId,
    skipNoChange: commentConfig.skipNoChange,
    commentStrategy: commentConfig.commentStrategy,
    token,
    showArtifactLinkWhenTruncated: Option.isSome(config.runIdOption),
  });

  // Set GitHub Actions output
  setDiffOutput(results);
});
