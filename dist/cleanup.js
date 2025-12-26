import { A as catchAll, I as gen, R as logInfo, W as runPromise, cr as require_core, n as removeWorktree, q as sync, yr as __toESM } from "./assets/git-D6XTKqCz.js";
var import_core = /* @__PURE__ */ __toESM(require_core(), 1);
var cleanup = gen(function* () {
	const worktreePath = yield* sync(() => import_core.getState("worktreePath"));
	if (!worktreePath) {
		yield* logInfo("No worktree path saved, skipping cleanup");
		return;
	}
	yield* removeWorktree(worktreePath);
	yield* logInfo(`Cleaned up worktree at ${worktreePath}`);
});
const run = () => cleanup.pipe(catchAll((error) => sync(() => import_core.warning(`Cleanup failed: ${error}`))), runPromise);
run();
export { run };

//# sourceMappingURL=cleanup.js.map