/**
 * Utility functions re-exported from service files
 *
 * This module separates pure utility functions from service interfaces.
 * Import services from "./index.js" and utilities from "./utils.js".
 */

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
