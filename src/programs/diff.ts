import { Effect } from "effect";
import type { ConfigError } from "effect/Config";
import { GitService, NixService, GitHubService, ArtifactService } from "../services/index.js";
import {
  NotPullRequestContextError,
  MissingAttributesError,
  AttributeParseError,
  GitWorktreeError,
  NixPathInfoError,
  NixBuildError,
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
  | NixBuildError
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

  // Upload JSON artifact for the aggregator to collect. HTML is generated
  // once in the comment job so the single rendered view covers all matrix legs.
  yield* artifactService.uploadJsonResult(results, config.attributes[0].displayName);
});
