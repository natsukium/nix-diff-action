import { $ as runPromise, At as warning, F as catchAll, G as logInfo, Tt as getState, U as gen, n as removeWorktree, nt as sync } from "./assets/git-HrE0GXIJ.js";
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