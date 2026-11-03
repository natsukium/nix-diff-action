import { Cn as warning, Z as catch_, _t as runPromise, at as gen, bt as sync, ct as logInfo, n as removeWorktree, vn as getState } from "./assets/git-GR0gyZGt.js";
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
var run = () => cleanup.pipe(catch_((error) => sync(() => warning(`Cleanup failed: ${error}`))), runPromise);
run();
export { run };

//# sourceMappingURL=cleanup.js.map