import { A as catchAll, At as warning, B as logInfo, J as runPromise, R as gen, Tt as getState, Z as sync, n as removeWorktree } from "./assets/git-DIvoUPor.js";
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