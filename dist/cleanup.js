import { $ as sync, B as gen, Et as getState, H as logInfo, M as catchAll, X as runPromise, jt as warning, n as removeWorktree } from "./assets/git-C8p4VvVT.js";
//#region src/cleanup.ts
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
//#endregion
export { run };

//# sourceMappingURL=cleanup.js.map