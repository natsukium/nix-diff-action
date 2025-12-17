import { Effect } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { GitService, NixService, GitHubService, ArtifactService } from "../services/index.js";
import {
  NotPullRequestContextError,
  MissingAttributesError,
  AttributeParseError,
  GitWorktreeError,
  NixPathInfoError,
  NixDixError,
  ArtifactError,
  InvalidDirectoryError,
} from "../errors.js";
import { runDiffPipeline, setDiffOutput } from "./shared.js";

// Error type alias for better readability
export type RunDiffError =
  | NotPullRequestContextError
  | MissingAttributesError
  | AttributeParseError
  | InvalidDirectoryError
  | GitWorktreeError
  | NixPathInfoError
  | NixDixError
  | ArtifactError
  | ConfigError;

export const runDiff: Effect.Effect<
  void,
  RunDiffError,
  GitService | NixService | GitHubService | ArtifactService
> = Effect.gen(function* () {
  const artifactService = yield* ArtifactService;

  // Run diff pipeline
  const { config, results } = yield* runDiffPipeline;

  // Set GitHub Actions output
  setDiffOutput(results);

  // Upload artifact with first attribute's displayName
  yield* artifactService.uploadDiffResults(results, config.attributes[0].displayName);
});
