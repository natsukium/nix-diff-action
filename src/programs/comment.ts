import { Effect } from "effect";
import type { ConfigError } from "effect/Config";
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

    // Render a single HTML artifact that aggregates all matrix legs. Generating
    // it here (rather than per-leg) is the only point where every result is
    // known at once, and one artifact keeps the Artifacts UI uncluttered.
    // The HTML viewer is a nice-to-have — if uploading it fails, keep going
    // so the PR comment still gets posted, but record the failure so the
    // comment does not advertise a link that would 404.
    const htmlViewerAvailable = yield* artifactService
      .uploadAggregatedHtml(results)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`HTML viewer artifact upload failed: ${error.message}`).pipe(
            Effect.as(false),
          ),
        ),
      );

    // Post comment to PR. `@actions/github` sets runId to 0 outside of a real
    // Actions run, in which case we have no valid Run URL to link to — treat
    // that as "no runId" so the HTML viewer link is omitted.
    yield* postComment({
      results,
      runId: context.runId > 0 ? String(context.runId) : undefined,
      skipNoChange: commentConfig.skipNoChange,
      commentStrategy: commentConfig.commentStrategy,
      token,
      htmlViewerAvailable,
    });
  });
