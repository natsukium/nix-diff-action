import * as core from "@actions/core";
import { Effect, Layer } from "effect";
import * as ConfigError from "effect/ConfigError";
import {
  MainLayer,
  GitService,
  NixService,
  GitHubService,
  ArtifactService,
} from "./services/index.js";
import { ConfigProviderLayer, ActionConfig } from "./config.js";
import {
  InvalidModeError,
  NotPullRequestContextError,
  MissingAttributesError,
  AttributeParseError,
  InvalidCommentStrategyError,
  InvalidDirectoryError,
  GitWorktreeError,
  NixPathInfoError,
  NixDixError,
  GitHubApiError,
  ArtifactError,
} from "./errors.js";
import { runFull, runDiff, runComment } from "./programs/index.js";
import type { RunFullError } from "./programs/full.js";
import type { RunDiffError } from "./programs/diff.js";
import type { RunCommentError } from "./programs/comment.js";

type ProgramError =
  | RunFullError
  | RunDiffError
  | RunCommentError
  | InvalidModeError
  | ConfigError.ConfigError;

type ProgramRequirements = GitService | NixService | GitHubService | ArtifactService;

const program: Effect.Effect<void, ProgramError, ProgramRequirements> = Effect.gen(function* () {
  const mode = yield* ActionConfig.mode;
  switch (mode) {
    case "full":
      return yield* runFull;
    case "diff-only":
      return yield* runDiff;
    case "comment-only":
      return yield* runComment;
  }
});

const setFailed = (message: string): Effect.Effect<void> =>
  Effect.sync(() => core.setFailed(message));

export const run = (): Promise<void> =>
  program.pipe(
    Effect.tapError((error) =>
      Effect.logError("Action failed", {
        error:
          typeof error === "object" && error !== null && "_tag" in error ? error._tag : "Unknown",
      }),
    ),
    Effect.catchTags({
      InvalidModeError: (e: InvalidModeError) => setFailed(`Invalid mode: ${e.mode}`),
      NotPullRequestContextError: (e: NotPullRequestContextError) => setFailed(e.message),
      MissingAttributesError: (e: MissingAttributesError) => setFailed(e.message),
      AttributeParseError: (e: AttributeParseError) => setFailed(e.message),
      InvalidCommentStrategyError: (e: InvalidCommentStrategyError) =>
        setFailed(`Invalid comment strategy: ${e.value}`),
      InvalidDirectoryError: (e: InvalidDirectoryError) => setFailed(e.message),
      GitWorktreeError: (e: GitWorktreeError) =>
        setFailed(`Git ${e.operation} failed: ${e.message}`),
      NixPathInfoError: (e: NixPathInfoError) =>
        setFailed(`Nix path-info failed for ${e.flakeRef}: ${e.message}`),
      NixDixError: (e: NixDixError) =>
        setFailed(`Nix dix failed comparing ${e.basePath} vs ${e.prPath}: ${e.message}`),
      GitHubApiError: (e: GitHubApiError) =>
        setFailed(`GitHub ${e.operation} failed: ${e.message}`),
      ArtifactError: (e: ArtifactError) => setFailed(`Artifact ${e.name} failed: ${e.message}`),
    }),
    // ConfigError uses _op instead of _tag, so handle it separately with catchIf
    Effect.catchIf(ConfigError.isConfigError, (e) => setFailed(`Configuration error: ${e}`)),
    // Catch any unexpected errors that slip through
    Effect.catchAll((error) => setFailed(`Unexpected error: ${error}`)),
    Effect.scoped,
    Effect.provide(Layer.merge(MainLayer, ConfigProviderLayer)),
    Effect.runPromise,
  );
