import * as github from "@actions/github";

export type GitHubContext = typeof github.context;
export type Octokit = ReturnType<typeof github.getOctokit>;

export type PullRequestPayload = {
  number: number;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
};

export type CommentStrategy = "create" | "update";

export type CommentOptions = {
  skipNoChange: boolean;
  commentStrategy: CommentStrategy;
};

export type WorktreeInfo = {
  path: string;
};
