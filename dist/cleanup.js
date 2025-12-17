import { F as gen, K as sync, L as logInfo, U as runPromise, k as catchAll, n as removeWorktree, sr as require_core, vr as __toESM } from "./assets/git-3H4i0TAR.js";
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