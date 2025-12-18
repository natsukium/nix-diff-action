import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as nodePath from "path";
import * as os from "os";
import { Effect, Scope } from "effect";
import { GitWorktreeError } from "../errors.js";
import type { WorktreeInfo } from "../types.js";

// Sanitize branch name to create a valid filesystem path
export const sanitizeBranchName = (ref: string): string => ref.replace(/[^a-zA-Z0-9-]/g, "-");

const execGit = (args: string[], ignoreReturnCode = false) =>
  Effect.tryPromise({
    try: () => exec.exec("git", args, { ignoreReturnCode }),
    catch: () =>
      new GitWorktreeError({
        operation: args[0] ?? "unknown",
        message: `Failed to execute git ${args.join(" ")}`,
      }),
  });

// Check if worktree exists by parsing `git worktree list --porcelain` output
// Returns false if the check fails (safe default for cleanup scenarios)
const worktreeExists = (path: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise({
    try: async () => {
      let stdout = "";
      await exec.exec("git", ["worktree", "list", "--porcelain"], {
        listeners: { stdout: (data: Buffer) => (stdout += data.toString()) },
        silent: true,
      });
      return stdout.includes(`worktree ${path}`);
    },
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning(`Failed to check worktree existence: ${error}`).pipe(Effect.as(false)),
    ),
  );

// Only remove worktree if it exists to avoid "fatal: not a working tree" message
export const removeWorktree = (path: string) =>
  worktreeExists(path).pipe(
    Effect.flatMap((exists) =>
      exists ? execGit(["worktree", "remove", "--force", path], true) : Effect.void,
    ),
    Effect.ignore,
  );

const fetchRef = (baseRef: string) =>
  Effect.tryPromise({
    try: () =>
      exec.exec("git", [
        "fetch",
        "origin",
        `+${baseRef}:refs/remotes/origin/${baseRef}`,
        "--depth=1",
      ]),
    catch: () =>
      new GitWorktreeError({
        operation: "fetch",
        message: `Failed to fetch ${baseRef}`,
      }),
  });

const addWorktree = (worktreePath: string, baseRef: string) =>
  Effect.tryPromise({
    try: () => exec.exec("git", ["worktree", "add", "--detach", worktreePath, `origin/${baseRef}`]),
    catch: () =>
      new GitWorktreeError({
        operation: "create",
        message: `Failed to create worktree for ${baseRef}`,
      }),
  });

export class GitService extends Effect.Service<GitService>()("GitService", {
  succeed: {
    createWorktree: (
      baseRef: string,
      runId: string,
    ): Effect.Effect<WorktreeInfo, GitWorktreeError, Scope.Scope> => {
      const worktreePath = nodePath.join(
        os.tmpdir(),
        `dix-base-${sanitizeBranchName(baseRef)}-${runId}`,
      );

      return Effect.acquireRelease(
        Effect.gen(function* () {
          yield* removeWorktree(worktreePath);
          yield* fetchRef(baseRef);
          yield* addWorktree(worktreePath, baseRef);
          // Save worktree path for cleanup in post action (handles timeout/cancel scenarios)
          yield* Effect.sync(() => core.saveState("worktreePath", worktreePath));
          yield* Effect.logInfo(`Created worktree for base branch ${baseRef} at ${worktreePath}`);
          return { path: worktreePath };
        }),
        (worktree) =>
          Effect.gen(function* () {
            yield* removeWorktree(worktree.path);
            yield* Effect.logInfo(`Cleaned up worktree at ${worktree.path}`);
          }),
      );
    },
  },
}) {}
