/**
 * Utility functions re-exported from service files
 *
 * This module separates pure utility functions from service interfaces.
 * Import services from "./index.js" and utilities from "./utils.js".
 */

import type { DiffResult } from "../schemas.js";

// Nix utilities

// Detect actual changes by comparing store paths: they are content-addressed,
// so identical paths mean identical content. The paths come from nix path-info
// rather than being parsed back out of dix's human-readable output, which is
// not a stable format across dix versions (and JSON output omits the paths
// entirely).
export const hasDixChanges = (result: Pick<DiffResult, "basePath" | "prPath">): boolean =>
  result.basePath !== result.prPath;

// Git utilities
export { sanitizeBranchName } from "./git.js";

// Artifact utilities
export { createArtifactName } from "./artifact.js";

// GitHub utilities
export {
  formatAggregatedComment,
  checkIfAnyDiffTruncated,
  truncateDiff,
  sanitizeDisplayName,
  type TruncateResult,
  type FormatCommentOptions,
} from "./github.js";
