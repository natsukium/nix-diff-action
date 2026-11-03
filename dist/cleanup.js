import { Sn as warning, X as catch_, _n as getState, gt as runPromise, it as gen, n as removeWorktree, st as logInfo, yt as sync } from "./assets/git-CK-MHdh0.js";
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