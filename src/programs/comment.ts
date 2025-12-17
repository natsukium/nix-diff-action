import { Effect } from "effect";
import type { ConfigError } from "effect/ConfigError";
import { GitHubService, ArtifactService } from "../services/index.js";
import {
  NotPullRequestContextError,
  InvalidCommentStrategyError,
  ArtifactError,
  GitHubApiError,
} from "../errors.js";
import { getGithubToken, loadCommentConfig, postComment } from "./shared.js";

// Error type alias for better readability
export type RunCommentError =
  | NotPullRequestContextError
  | InvalidCommentStrategyError
  | ArtifactError
  | GitHubApiError
  | ConfigError;

export const runComment: Effect.Effect<void, RunCommentError, GitHubService | ArtifactService> =
  Effect.gen(function* () {
    const githubService = yield* GitHubService;
    const artifactService = yield* ArtifactService;
    const context = githubService.getContext();

    const token = yield* getGithubToken;
    const commentConfig = yield* loadCommentConfig;

    const results = yield* artifactService.downloadAllDiffResults(
      token,
      context.runId,
      context.repo.owner,
      context.repo.repo,
    );

    // Post comment to PR
    yield* postComment({
      results,
      runId: String(context.runId),
      skipNoChange: commentConfig.skipNoChange,
      commentStrategy: commentConfig.commentStrategy,
      token,
      showArtifactLinkWhenTruncated: true,
    });
  });
