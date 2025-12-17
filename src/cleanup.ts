import * as core from "@actions/core";
import { Effect } from "effect";
import { removeWorktree } from "./services/git.js";

const cleanup = Effect.gen(function* () {
  const worktreePath = yield* Effect.sync(() => core.getState("worktreePath"));

  if (!worktreePath) {
    yield* Effect.logInfo("No worktree path saved, skipping cleanup");
    return;
  }

  yield* removeWorktree(worktreePath);
  yield* Effect.logInfo(`Cleaned up worktree at ${worktreePath}`);
});

// Export for testability - allows mocking and unit testing
export const run = (): Promise<void> =>
  cleanup.pipe(
    Effect.catchAll((error) => Effect.sync(() => core.warning(`Cleanup failed: ${error}`))),
    Effect.runPromise,
  );

// Entry point: only execute when run directly as GitHub Actions post script
run();
