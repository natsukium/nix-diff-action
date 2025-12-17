import { Layer } from "effect";
import { GitService } from "./git.js";
import { NixService } from "./nix.js";
import { GitHubService } from "./github.js";
import { ArtifactService } from "./artifact.js";

// Service exports only - for utilities, import from "./utils.js"
export { GitService } from "./git.js";
export { NixService } from "./nix.js";
export { GitHubService } from "./github.js";
export { ArtifactService } from "./artifact.js";

export const MainLayer = Layer.mergeAll(
  GitService.Default,
  NixService.Default,
  GitHubService.Default,
  ArtifactService.Default,
);
