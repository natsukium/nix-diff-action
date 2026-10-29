import { K as logInfo, L as catchAll, Pt as getState, W as gen, et as runPromise, n as removeWorktree, rt as sync, zt as warning } from "./assets/git-uNXLhHWu.js";
// src/cleanup.ts
var cleanup = gen(function* () {
	const worktreePath = yield* sync(() => getState("worktreePath"));
	if (!worktreePath) {
		yield* logInfo("No worktree path saved, skipping cleanup");
		return;
	}
	yield* removeWorktree(worktreePath);
	yield* logInfo(`Cleaned up worktree at ${worktreePath}`);
});
var run = () => cleanup.pipe(catchAll((error) => sync(() => warning(`Cleanup failed: ${error}`))), runPromise);
run();
export { run };

//# sourceMappingURL=cleanup.js.map