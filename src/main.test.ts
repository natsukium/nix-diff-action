import { describe, expect, test } from "vitest";
import { Effect, Either, Exit, Layer } from "effect";
import { formatAggregatedComment, truncateDiff, sanitizeDisplayName } from "./services/github.js";
import { parseCommentStrategy, parseAttributes, validateDirectory } from "./programs/index.js";
import { processDiffResults } from "./programs/full.js";
import { GitService, sanitizeBranchName } from "./services/git.js";
import { NixService, decodeDixReport, selectDixCli } from "./services/nix.js";
import { hasDixChanges } from "./services/utils.js";
import { createArtifactName } from "./services/artifact.js";
import { generateDiffHtml, slugify } from "./services/html.js";
import {
  formatBytes,
  formatSignedBytes,
  isUnchanged,
  stripPrefix,
  viewFromReport,
  viewFromText,
} from "./services/view.js";
import type { DixPackageDiff, DixReport } from "./schemas.js";

const textOutput = (text: string) => ({ format: "text" as const, text });

describe("parseAttributes", () => {
  test("parses valid YAML array", async () => {
    const input = `
- displayName: host1
  attribute: nixosConfigurations.host1.config.system.build.toplevel
- displayName: host2
  attribute: nixosConfigurations.host2.config.system.build.toplevel
`;
    const result = await Effect.runPromise(parseAttributes(input));
    expect(result).toHaveLength(2);
    expect(result[0].displayName).toBe("host1");
    expect(result[0].attribute).toBe("nixosConfigurations.host1.config.system.build.toplevel");
    expect(result[1].displayName).toBe("host2");
    expect(result[1].attribute).toBe("nixosConfigurations.host2.config.system.build.toplevel");
  });

  test("fails for non-array input", async () => {
    const input = "displayName: host1";
    const exit = await Effect.runPromiseExit(parseAttributes(input));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("AttributeParseError");
        expect(error.error.message).toBe("attributes must be a YAML array");
      }
    }
  });

  test("fails for missing displayName", async () => {
    const input = `
- attribute: nixosConfigurations.host1.config.system.build.toplevel
`;
    const exit = await Effect.runPromiseExit(parseAttributes(input));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("AttributeParseError");
        expect(error.error.message).toContain("Invalid attributes format");
      }
    }
  });

  test("fails for missing attribute", async () => {
    const input = `
- displayName: host1
`;
    const exit = await Effect.runPromiseExit(parseAttributes(input));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("AttributeParseError");
        expect(error.error.message).toContain("Invalid attributes format");
      }
    }
  });

  test("parses singleton array (for diff-only mode with matrix)", async () => {
    const input = `
- displayName: host1
  attribute: nixosConfigurations.host1.config.system.build.toplevel
`;
    const result = await Effect.runPromise(parseAttributes(input));
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe("host1");
    expect(result[0].attribute).toBe("nixosConfigurations.host1.config.system.build.toplevel");
  });
});

describe("parseCommentStrategy", () => {
  // Empty string is now handled at Config layer (Config.map transforms "" to "create")
  // parseCommentStrategy only validates non-empty values
  test("fails for empty input (full mode handled at Config layer)", async () => {
    const exit = await Effect.runPromiseExit(parseCommentStrategy(""));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("InvalidCommentStrategyError");
      }
    }
  });

  test("returns 'create' for 'create' input", async () => {
    const result = await Effect.runPromise(parseCommentStrategy("create"));
    expect(result).toBe("create");
  });

  test("returns 'update' for 'update' input", async () => {
    const result = await Effect.runPromise(parseCommentStrategy("update"));
    expect(result).toBe("update");
  });

  test("fails for invalid input", async () => {
    const exit = await Effect.runPromiseExit(parseCommentStrategy("invalid"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("InvalidCommentStrategyError");
        expect(error.error.value).toBe("invalid");
      }
    }
  });
});

describe("formatAggregatedComment", () => {
  test("formats single result with displayName-specific marker", () => {
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1.config.system.build.toplevel",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput("some diff output"),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456");

    // Single attribute uses displayName-specific marker
    expect(comment).toContain("<!-- nix-diff-action:host1 -->");
    expect(comment).toContain("## Nix Diff");
    expect(comment).toContain("### host1");
    expect(comment).toContain(
      "**Attribute**: `nixosConfigurations.host1.config.system.build.toplevel`",
    );
    expect(comment).toContain("`github:owner/repo...."); // baseRef...prRef
    expect(comment).toContain("some diff output");
    expect(comment).toContain("<!-- nix-diff-action-footer sha=abc123def456 -->");
    expect(comment).toContain("[nix-diff-action](https://github.com/natsukium/nix-diff-action)");
    expect(comment).toContain("[dix](https://github.com/manic-systems/dix)");
  });

  test("formats multiple results with generic marker", () => {
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput("diff1"),
      },
      {
        displayName: "host2",
        attributePath: "nixosConfigurations.host2...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput("diff2"),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456");

    // Multiple attributes use generic marker
    expect(comment).toContain("<!-- nix-diff-action -->");
    expect(comment).not.toContain("<!-- nix-diff-action:host1 -->");
    expect(comment).toContain("### host1");
    expect(comment).toContain("### host2");
    expect(comment).toContain("diff1");
    expect(comment).toContain("diff2");
  });

  test("truncates large diff", () => {
    const largeDiff = "a".repeat(70000);
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput(largeDiff),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456");

    expect(comment).toContain("... (truncated, 70000 chars total)");
    expect(comment.length).toBeLessThan(65536);
  });

  test("distributes space equally among multiple large diffs", () => {
    const largeDiff = "b".repeat(50000);
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput(largeDiff),
      },
      {
        displayName: "host2",
        attributePath: "nixosConfigurations.host2...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput(largeDiff),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456");

    // Both diffs should be truncated since 50000 * 2 > 60000 limit
    expect((comment.match(/Diff was truncated/g) || []).length).toBe(2);
    expect(comment.length).toBeLessThan(65536);
  });

  test("keeps total comment under limit with many attributes", () => {
    const largeDiff = "c".repeat(30000);
    const results = Array.from({ length: 5 }, (_, i) => ({
      displayName: `host${i + 1}`,
      attributePath: `nixosConfigurations.host${i + 1}...`,
      baseRef: "github:owner/repo",
      prRef: ".",
      basePath: "/nix/store/aaa-base",
      prPath: "/nix/store/bbb-pr",
      diff: textOutput(largeDiff),
    }));
    const comment = formatAggregatedComment(results, "abc123def456");

    expect(comment.length).toBeLessThan(65536);
  });

  test("shows truncation notice when truncated", () => {
    const largeDiff = "d".repeat(70000);
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput(largeDiff),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456", {
      runId: "12345",
      repoUrl: "https://github.com/owner/repo",
      htmlViewerAvailable: true,
    });

    expect(comment).toContain("Diff was truncated");
    expect(comment).toContain("View diff as HTML");
  });

  test("no truncation notice when not truncated but still shows HTML viewer link", () => {
    const smallDiff = "small diff";
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput(smallDiff),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456", {
      runId: "12345",
      repoUrl: "https://github.com/owner/repo",
      htmlViewerAvailable: true,
    });

    expect(comment).not.toContain("Diff was truncated");
    expect(comment).toContain("View diff as HTML");
    expect(comment).toContain("https://github.com/owner/repo/actions/runs/12345");
  });

  // Guards the contract between ArtifactService.uploadAggregatedHtml and the
  // comment body: if the upload was skipped/failed, the link must be omitted
  // so users don't click through to a 404.
  test("omits HTML viewer link when artifact is unavailable", () => {
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput("small diff"),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456", {
      runId: "12345",
      repoUrl: "https://github.com/owner/repo",
      htmlViewerAvailable: false,
    });

    expect(comment).not.toContain("View diff as HTML");
  });

  test("omits HTML viewer link when htmlViewerAvailable is undefined", () => {
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput("small diff"),
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456", {
      runId: "12345",
      repoUrl: "https://github.com/owner/repo",
    });

    expect(comment).not.toContain("View diff as HTML");
  });
});

describe("truncateDiff", () => {
  test("returns original string when under limit", () => {
    const diff = "small diff";
    const result = truncateDiff(diff, 60000);
    expect(result.text).toBe(diff);
    expect(result.truncated).toBe(false);
  });

  test("truncates string when over limit", () => {
    const largeDiff = "x".repeat(70000);
    const result = truncateDiff(largeDiff, 60000);
    expect(result.text).toContain("... (truncated, 70000 chars total)");
    expect(result.text.length).toBeLessThan(65000);
    expect(result.truncated).toBe(true);
  });

  test("handles exactly at limit", () => {
    const exactDiff = "y".repeat(60000);
    const result = truncateDiff(exactDiff, 60000);
    expect(result.text).toBe(exactDiff);
    expect(result.truncated).toBe(false);
  });

  test("respects custom maxLength", () => {
    const diff = "a".repeat(5000);
    const result = truncateDiff(diff, 1000);
    expect(result.text).toContain("... (truncated, 5000 chars total)");
    expect(result.text.length).toBeLessThan(1500);
    expect(result.truncated).toBe(true);
  });
});

describe("sanitizeBranchName", () => {
  test("keeps alphanumeric characters and hyphens", () => {
    expect(sanitizeBranchName("main")).toBe("main");
    expect(sanitizeBranchName("feature-123")).toBe("feature-123");
  });

  test("replaces slashes with hyphens", () => {
    expect(sanitizeBranchName("feature/new-feature")).toBe("feature-new-feature");
    expect(sanitizeBranchName("user/name/branch")).toBe("user-name-branch");
  });

  test("replaces other special characters", () => {
    expect(sanitizeBranchName("branch:name")).toBe("branch-name");
    expect(sanitizeBranchName("branch.name")).toBe("branch-name");
    expect(sanitizeBranchName("branch@name")).toBe("branch-name");
  });

  test("handles complex branch names", () => {
    expect(sanitizeBranchName("refs/heads/feature/test")).toBe("refs-heads-feature-test");
  });
});

describe("validateDirectory", () => {
  const workspaceRoot = "/workspace";

  test("accepts current directory '.'", async () => {
    const result = await Effect.runPromise(validateDirectory(".", workspaceRoot));
    expect(result).toBe("/workspace");
  });

  test("accepts subdirectory 'subdir'", async () => {
    const result = await Effect.runPromise(validateDirectory("subdir", workspaceRoot));
    expect(result).toBe("/workspace/subdir");
  });

  test("accepts subdirectory './subdir'", async () => {
    const result = await Effect.runPromise(validateDirectory("./subdir", workspaceRoot));
    expect(result).toBe("/workspace/subdir");
  });

  test("accepts nested subdirectory 'a/b/c'", async () => {
    const result = await Effect.runPromise(validateDirectory("a/b/c", workspaceRoot));
    expect(result).toBe("/workspace/a/b/c");
  });

  test("rejects path traversal '../'", async () => {
    const exit = await Effect.runPromiseExit(validateDirectory("../", workspaceRoot));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("InvalidDirectoryError");
        expect(error.error.message).toContain("must be within the workspace");
      }
    }
  });

  test("rejects path traversal '../sibling'", async () => {
    const exit = await Effect.runPromiseExit(validateDirectory("../sibling", workspaceRoot));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("InvalidDirectoryError");
      }
    }
  });

  test("rejects absolute path outside workspace '/etc'", async () => {
    const exit = await Effect.runPromiseExit(validateDirectory("/etc", workspaceRoot));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("InvalidDirectoryError");
      }
    }
  });

  test("rejects prefix attack '/workspace-evil'", async () => {
    const exit = await Effect.runPromiseExit(validateDirectory("/workspace-evil", workspaceRoot));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("InvalidDirectoryError");
      }
    }
  });

  test("rejects deeply nested path traversal 'a/../../b'", async () => {
    const exit = await Effect.runPromiseExit(validateDirectory("a/../../b", workspaceRoot));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause;
      expect(error._tag).toBe("Fail");
      if (error._tag === "Fail") {
        expect(error.error._tag).toBe("InvalidDirectoryError");
      }
    }
  });
});

describe("processDiffResults", () => {
  const createMockGitService = (worktreePath: string) =>
    Layer.succeed(
      GitService,
      new GitService({
        createWorktree: (_baseRef: string, _runId: string) =>
          Effect.acquireRelease(Effect.succeed({ path: worktreePath }), () => Effect.void),
      }),
    );

  const createMockNixService = (capturedFlakeRefs: string[], capturedInputsFromRefs?: string[]) =>
    Layer.succeed(
      NixService,
      new NixService({
        prefetchFlakeInputs: () => Effect.void,
        getNixPath: (flakeRef: string) => {
          capturedFlakeRefs.push(flakeRef);
          return Effect.succeed(`/nix/store/mock-hash`);
        },
        getDixDiff: (_basePath: string, _prPath: string, inputsFromRef: string) => {
          capturedInputsFromRefs?.push(inputsFromRef);
          return Effect.succeed(textOutput("mock diff output"));
        },
      }),
    );

  test("constructs correct paths when directory equals cwd", async () => {
    const worktreePath = "/tmp/dix-base-main";
    const directory = "/workspace/repo";
    const cwd = "/workspace/repo";
    const capturedFlakeRefs: string[] = [];
    const capturedInputsFromRefs: string[] = [];

    const mockGit = createMockGitService(worktreePath);
    const mockNix = createMockNixService(capturedFlakeRefs, capturedInputsFromRefs);
    const testLayer = Layer.mergeAll(mockGit, mockNix);

    const result = await Effect.runPromise(
      Effect.scoped(
        processDiffResults({
          attributes: [{ displayName: "test", attribute: "packages.x86_64-linux.default" }],
          build: false,
          directory,
          baseRef: "main",
          baseSha: "abc123def456",
          headSha: "789ghi012jkl",
          cwd,
          runId: "test-run-id",
        }),
      ).pipe(Effect.provide(testLayer)),
    );

    expect(result).toHaveLength(1);
    // baseRef and prRef should contain commit SHAs
    expect(result[0].baseRef).toBe("abc123def456");
    expect(result[0].prRef).toBe("789ghi012jkl");
    expect(result[0].diff).toEqual(textOutput("mock diff output"));
    expect(result[0].basePath).toBe("/nix/store/mock-hash");
    expect(result[0].prPath).toBe("/nix/store/mock-hash");

    // Verify getNixPath was called with correct flake refs
    expect(capturedFlakeRefs).toContain("path:/tmp/dix-base-main#packages.x86_64-linux.default");
    expect(capturedFlakeRefs).toContain("/workspace/repo#packages.x86_64-linux.default");

    // Security: Verify getDixDiff uses base branch worktree (not PR branch)
    // This prevents malicious flake.lock in PR from injecting compromised dix
    expect(capturedInputsFromRefs).toEqual([`path:${worktreePath}`]);
  });

  test("constructs correct paths for subdirectory", async () => {
    const worktreePath = "/tmp/dix-base-main";
    const directory = "/workspace/repo/packages/myflake";
    const cwd = "/workspace/repo";
    const capturedFlakeRefs: string[] = [];
    const capturedInputsFromRefs: string[] = [];

    const mockGit = createMockGitService(worktreePath);
    const mockNix = createMockNixService(capturedFlakeRefs, capturedInputsFromRefs);
    const testLayer = Layer.mergeAll(mockGit, mockNix);

    const result = await Effect.runPromise(
      Effect.scoped(
        processDiffResults({
          attributes: [{ displayName: "test", attribute: "packages.x86_64-linux.default" }],
          build: false,
          directory,
          baseRef: "main",
          baseSha: "abc123def456",
          headSha: "789ghi012jkl",
          cwd,
          runId: "test-run-id",
        }),
      ).pipe(Effect.provide(testLayer)),
    );

    expect(result).toHaveLength(1);
    // baseRef and prRef should contain commit SHAs
    expect(result[0].baseRef).toBe("abc123def456");
    expect(result[0].prRef).toBe("789ghi012jkl");

    // Verify getNixPath was called with correct flake refs
    expect(capturedFlakeRefs).toContain(
      "path:/tmp/dix-base-main?dir=packages/myflake#packages.x86_64-linux.default",
    );
    expect(capturedFlakeRefs).toContain(
      "/workspace/repo/packages/myflake#packages.x86_64-linux.default",
    );

    // dix must resolve its inputs from the base flake inside the subdirectory,
    // since the worktree root has no flake.nix
    expect(capturedInputsFromRefs).toEqual(["path:/tmp/dix-base-main?dir=packages/myflake"]);
  });

  test("percent-encodes reserved characters in the subdirectory query", async () => {
    const worktreePath = "/tmp/dix-base-main";
    const directory = "/workspace/repo/a&b/my flake%#?";
    const cwd = "/workspace/repo";
    const capturedFlakeRefs: string[] = [];
    const capturedInputsFromRefs: string[] = [];

    const mockGit = createMockGitService(worktreePath);
    const mockNix = createMockNixService(capturedFlakeRefs, capturedInputsFromRefs);
    const testLayer = Layer.mergeAll(mockGit, mockNix);

    await Effect.runPromise(
      Effect.scoped(
        processDiffResults({
          attributes: [{ displayName: "test", attribute: "packages.x86_64-linux.default" }],
          build: false,
          directory,
          baseRef: "main",
          baseSha: "abc123def456",
          headSha: "789ghi012jkl",
          cwd,
          runId: "test-run-id",
        }),
      ).pipe(Effect.provide(testLayer)),
    );

    expect(capturedFlakeRefs).toContain(
      "path:/tmp/dix-base-main?dir=a%26b/my%20flake%25%23%3F#packages.x86_64-linux.default",
    );
    expect(capturedInputsFromRefs).toEqual([
      "path:/tmp/dix-base-main?dir=a%26b/my%20flake%25%23%3F",
    ]);
  });

  test("processes multiple attributes", async () => {
    const worktreePath = "/tmp/dix-base-main";
    const directory = "/workspace/repo";
    const cwd = "/workspace/repo";
    const capturedFlakeRefs: string[] = [];

    const mockGit = createMockGitService(worktreePath);
    const mockNix = createMockNixService(capturedFlakeRefs);
    const testLayer = Layer.mergeAll(mockGit, mockNix);

    const result = await Effect.runPromise(
      Effect.scoped(
        processDiffResults({
          attributes: [
            { displayName: "host1", attribute: "nixosConfigurations.host1" },
            { displayName: "host2", attribute: "nixosConfigurations.host2" },
          ],
          build: false,
          directory,
          baseRef: "main",
          baseSha: "abc123def456",
          headSha: "789ghi012jkl",
          cwd,
          runId: "test-run-id",
        }),
      ).pipe(Effect.provide(testLayer)),
    );

    expect(result).toHaveLength(2);
    // All results should have the same commit SHAs
    expect(result[0].baseRef).toBe("abc123def456");
    expect(result[0].prRef).toBe("789ghi012jkl");
    expect(result[1].baseRef).toBe("abc123def456");
    expect(result[1].prRef).toBe("789ghi012jkl");
    expect(result[0].displayName).toBe("host1");
    expect(result[0].attributePath).toBe("nixosConfigurations.host1");
    expect(result[1].displayName).toBe("host2");
    expect(result[1].attributePath).toBe("nixosConfigurations.host2");
  });
});

describe("sanitizeDisplayName", () => {
  test("removes backslash", () => {
    expect(sanitizeDisplayName("test\\path")).toBe("testpath");
  });

  test("removes asterisks", () => {
    expect(sanitizeDisplayName("*bold*")).toBe("bold");
  });

  test("removes underscores", () => {
    expect(sanitizeDisplayName("_italic_")).toBe("italic");
  });

  test("removes backticks", () => {
    expect(sanitizeDisplayName("`code`")).toBe("code");
  });

  test("removes brackets and parentheses", () => {
    expect(sanitizeDisplayName("[link](url)")).toBe("linkurl");
  });

  test("removes hash", () => {
    expect(sanitizeDisplayName("# heading")).toBe(" heading");
  });

  test("keeps alphanumeric characters and hyphens", () => {
    expect(sanitizeDisplayName("host1")).toBe("host1");
    expect(sanitizeDisplayName("myapp-x86_64")).toBe("myapp-x8664");
  });

  test("keeps dots", () => {
    expect(sanitizeDisplayName("host.example.com")).toBe("host.example.com");
  });

  test("preserves Japanese characters", () => {
    expect(sanitizeDisplayName("ホスト1")).toBe("ホスト1");
    expect(sanitizeDisplayName("サーバー.example")).toBe("サーバー.example");
  });

  test("removes multiple special characters", () => {
    expect(sanitizeDisplayName("*_`test`_*")).toBe("test");
  });
});

describe("createArtifactName", () => {
  test("creates valid artifact name from simple displayName", () => {
    const result = createArtifactName("myhost");
    expect(result).toMatch(/^diff-result-myhost-[a-f0-9]{6}$/);
  });

  test("sanitizes special characters in displayName", () => {
    const result = createArtifactName("my/host:name");
    expect(result).toMatch(/^diff-result-my-host-name-[a-f0-9]{6}$/);
  });

  test("handles displayName with dots", () => {
    const result = createArtifactName("host.example.com");
    expect(result).toMatch(/^diff-result-host-example-com-[a-f0-9]{6}$/);
  });

  test("generates consistent hash for same input", () => {
    const result1 = createArtifactName("testhost");
    const result2 = createArtifactName("testhost");
    expect(result1).toBe(result2);
  });

  test("generates different hash for different input", () => {
    const result1 = createArtifactName("host1");
    const result2 = createArtifactName("host2");
    expect(result1).not.toBe(result2);
  });

  test("preserves hyphens and underscores", () => {
    const result = createArtifactName("my-host_name");
    expect(result).toMatch(/^diff-result-my-host_name-[a-f0-9]{6}$/);
  });
});

describe("hasDixChanges", () => {
  test("returns false when store paths are identical", () => {
    expect(
      hasDixChanges({
        basePath: "/nix/store/c46hfz9v6wx96dbchx8szp3xf6di3hb7-nix-shell.drv",
        prPath: "/nix/store/c46hfz9v6wx96dbchx8szp3xf6di3hb7-nix-shell.drv",
      }),
    ).toBe(false);
  });

  test("returns true when store paths differ", () => {
    expect(
      hasDixChanges({
        basePath: "/nix/store/abc123-old.drv",
        prPath: "/nix/store/def456-new.drv",
      }),
    ).toBe(true);
  });
});

describe("viewFromText", () => {
  test("parses sections and size lines, ignoring the store path header", () => {
    const diff = `<<< /nix/store/abc123-old.drv
>>> /nix/store/def456-new.drv

ADDED
[A.] new-pkg   1.0.0

REMOVED
[R.] old-pkg   0.9.0

CHANGED
[C.] shared-pkg   1.0.0 -> 2.0.0

SIZE: 10.0 MiB -> 12.0 MiB
DIFF: 500 KiB`;
    const view = viewFromText(diff);

    expect(view.added).toEqual([{ name: "new-pkg", version: "1.0.0" }]);
    expect(view.removed).toEqual([{ name: "old-pkg", version: "0.9.0" }]);
    expect(view.changed).toEqual([{ name: "shared-pkg", version: "1.0.0 -> 2.0.0" }]);
    expect(view.size).toEqual({ before: "10.0 MiB", after: "12.0 MiB", delta: "500 KiB" });
  });

  test("recognizes headings with a package count", () => {
    const view = viewFromText(`CHANGED (1)
[U.] pkg   1 → 2`);
    expect(view.changed).toEqual([{ name: "pkg", version: "1 → 2" }]);
  });

  test("treats empty input as fully unchanged", () => {
    const view = viewFromText("");
    expect(isUnchanged(view)).toBe(true);
  });

  test("ignores lines outside any section", () => {
    const view = viewFromText(`some preamble line
another stray line`);
    expect(isUnchanged(view)).toBe(true);
  });

  test("stops collecting section entries after a blank line", () => {
    const view = viewFromText(`ADDED
[A.] first   1.0

stray-line`);
    expect(view.added).toEqual([{ name: "first", version: "1.0" }]);
  });

  test("ignores a size line without an arrow", () => {
    const view = viewFromText("SIZE: 10.0 MiB");
    expect(view.size).toBeUndefined();
  });
});

describe("stripPrefix", () => {
  test("strips standard 2-char dix marker", () => {
    expect(stripPrefix("[A.] pkg   1.0")).toBe("pkg   1.0");
    expect(stripPrefix("[C.] pkg   1 -> 2")).toBe("pkg   1 -> 2");
  });

  test("strips selection markers", () => {
    expect(stripPrefix("[U*] pkg   1 -> 2")).toBe("pkg   1 -> 2");
    expect(stripPrefix("[R-] pkg   1.0")).toBe("pkg   1.0");
  });

  test("accepts 1-4 char markers to tolerate dix format changes", () => {
    expect(stripPrefix("[A] pkg   1.0")).toBe("pkg   1.0");
    expect(stripPrefix("[ADD] pkg   1.0")).toBe("pkg   1.0");
    expect(stripPrefix("[ADDE] pkg   1.0")).toBe("pkg   1.0");
  });

  test("leaves lines without a bracket marker unchanged", () => {
    expect(stripPrefix("pkg   1.0")).toBe("pkg   1.0");
  });
});

describe("selectDixCli", () => {
  test("uses the diff subcommand with JSON for dix 3", () => {
    const cli = selectDixCli("dix 3.0.0");
    expect(cli.version).toBe("3.0.0");
    expect(cli.json?.("/a", "/b")).toEqual(["diff", "--output", "json", "/a", "/b"]);
    expect(cli.text("/a", "/b")).toEqual(["diff", "/a", "/b"]);
  });

  test("uses top-level --output json with --force-correctness for dix 2", () => {
    const cli = selectDixCli("dix 2.2.0");
    expect(cli.json?.("/a", "/b")).toEqual(["--force-correctness", "--output", "json", "/a", "/b"]);
  });

  test("has no JSON invocation for dix 1", () => {
    const cli = selectDixCli("dix 1.4.2");
    expect(cli.json).toBeUndefined();
    expect(cli.text("/a", "/b")).toEqual(["--force-correctness", "/a", "/b"]);
  });

  test("omits --force-correctness before dix 1.4.2", () => {
    expect(selectDixCli("dix 1.4.1").text("/a", "/b")).toEqual(["/a", "/b"]);
  });

  test("treats an unrecognized version as the newest CLI", () => {
    const cli = selectDixCli("");
    expect(cli.version).toBe("unknown");
    expect(cli.json?.("/a", "/b")).toEqual(["diff", "--output", "json", "/a", "/b"]);
  });
});

// Output of `dix diff --output json` from dix 3.0.0's own JSON test.
const dix3Json = `{"diffs":[{"name":"nixos","versions":[{"kind":"changed","old":{"name":"25.11-system-path","amount":1},"new":{"name":"25.12-system-path","amount":1}},{"kind":"amount_changed","version":{"name":"25.12-system"},"old_amount":1,"new_amount":2}],"status":"Changed","kind":"version","selection":"Unselected","has_omitted_versions":false,"size_old":1000,"size_new":2500,"size_delta":1500}],"paths":{"old":7529,"new":7536,"added":5054,"removed":5047},"size_old":115001000,"size_new":115001000}`;

describe("decodeDixReport", () => {
  test("decodes dix 3 JSON output", () => {
    const decoded = decodeDixReport(dix3Json);
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.diffs[0].name).toBe("nixos");
      expect(decoded.right.paths.added).toBe(5054);
    }
  });

  test("decodes dix 2 JSON output, which lacks the kind field", () => {
    const dix2 = JSON.parse(dix3Json);
    delete dix2.diffs[0].kind;
    expect(Either.isRight(decodeDixReport(JSON.stringify(dix2)))).toBe(true);
  });

  test("rejects output whose schema changed incompatibly", () => {
    expect(Either.isLeft(decodeDixReport(`{"packages":[]}`))).toBe(true);
    expect(Either.isLeft(decodeDixReport("not json"))).toBe(true);
  });
});

const pkg = (overrides: Partial<DixPackageDiff>): DixPackageDiff => ({
  name: "pkg",
  versions: [],
  status: "Changed",
  selection: "Unselected",
  has_omitted_versions: false,
  size_old: 0,
  size_new: 0,
  size_delta: 0,
  ...overrides,
});

const report = (diffs: DixPackageDiff[]): DixReport => ({
  diffs,
  paths: { old: 10, new: 11, added: 2, removed: 1 },
  size_old: 10 * 1024 * 1024,
  size_new: 12 * 1024 * 1024,
});

describe("viewFromReport", () => {
  test("groups packages by status and describes their versions", () => {
    const view = viewFromReport(
      report([
        pkg({
          name: "curl",
          status: "Upgraded",
          versions: [
            {
              kind: "changed",
              old: { name: "8.0", amount: 1 },
              new: { name: "8.1", amount: 1 },
            },
          ],
        }),
        pkg({
          name: "jq",
          status: "Added",
          versions: [{ kind: "added", version: { name: "1.7", amount: 1 } }],
        }),
        pkg({
          name: "src",
          status: "Removed",
          versions: [{ kind: "removed", version: { name: null, amount: 1 } }],
        }),
      ]),
    );

    expect(view.changed).toEqual([{ name: "curl", version: "8.0 → 8.1", sizeDelta: undefined }]);
    expect(view.added).toEqual([{ name: "jq", version: "1.7", sizeDelta: undefined }]);
    expect(view.removed).toEqual([{ name: "src", version: "<none>", sizeDelta: undefined }]);
    expect(view.size).toEqual({ before: "10.0 MiB", after: "12.0 MiB", delta: "+2.0 MiB" });
    expect(view.paths).toEqual({ old: 10, new: 11, added: 2, removed: 1 });
  });

  test("shows amount changes with multiplicity when their size changed enough", () => {
    const view = viewFromReport(
      report([
        pkg({
          size_delta: 2 * 1024 * 1024,
          versions: [
            { kind: "amount_changed", version: { name: "1.0" }, old_amount: 1, new_amount: 2 },
          ],
        }),
      ]),
    );
    expect(view.changed[0].version).toBe("1.0 → 1.0 ×2");
  });

  test("hides amount-only changes below 1 MiB like dix's human output", () => {
    const view = viewFromReport(
      report([
        pkg({
          size_delta: 1024,
          versions: [
            { kind: "amount_changed", version: { name: "1.0" }, old_amount: 1, new_amount: 2 },
          ],
        }),
      ]),
    );
    expect(view.hiddenCount).toBe(1);
    expect(view.changed).toEqual([]);
  });

  test("marks versions dix omitted because they stayed unchanged", () => {
    const view = viewFromReport(
      report([
        pkg({
          name: "python3",
          status: "Upgraded",
          has_omitted_versions: true,
          versions: [
            {
              kind: "changed",
              old: { name: "3.12.1", amount: 1 },
              new: { name: "3.12.2", amount: 1 },
            },
          ],
        }),
      ]),
    );
    expect(view.changed[0].version).toBe("3.12.1, <unchanged> → 3.12.2, <unchanged>");
  });

  test("hides size-only changes below 1 MiB like dix's human output", () => {
    const view = viewFromReport(
      report([
        pkg({ name: "small", size_delta: 1024 }),
        pkg({ name: "large", size_delta: 2 * 1024 * 1024 }),
      ]),
    );
    expect(view.hiddenCount).toBe(1);
    expect(view.changed).toEqual([{ name: "large", version: "", sizeDelta: "+2.0 MiB" }]);
  });
});

describe("formatBytes", () => {
  test("uses binary units with one decimal", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(-19.3 * 1024 * 1024)).toBe("-19.3 MiB");
  });

  test("signs positive deltas", () => {
    expect(formatSignedBytes(1024)).toBe("+1.0 KiB");
    expect(formatSignedBytes(0)).toBe("0 B");
  });
});

describe("formatAggregatedComment with JSON reports", () => {
  const jsonResult = (r: DixReport) => ({
    displayName: "host1",
    attributePath: "nixosConfigurations.host1",
    baseRef: "abc",
    prRef: "def",
    basePath: "/nix/store/aaa-base",
    prPath: "/nix/store/bbb-pr",
    diff: { format: "json" as const, report: r },
  });

  test("renders closure stats and per-status package tables", () => {
    const comment = formatAggregatedComment(
      [
        jsonResult(
          report([
            pkg({
              name: "curl",
              status: "Upgraded",
              size_delta: 4096,
              versions: [
                {
                  kind: "changed",
                  old: { name: "8.0", amount: 1 },
                  new: { name: "8.1", amount: 1 },
                },
              ],
            }),
            pkg({
              name: "jq",
              status: "Added",
              versions: [{ kind: "added", version: { name: "1.7", amount: 1 } }],
            }),
          ]),
        ),
      ],
      "sha",
    );

    expect(comment).toContain("| Closure size | `10.0 MiB` | `12.0 MiB` | `+2.0 MiB` |");
    expect(comment).toContain("| Store paths | 10 | 11 | +2 / −1 |");
    expect(comment).toContain("<summary>Changed (1)</summary>");
    expect(comment).toContain("| `curl` | `8.0 → 8.1` | +4.0 KiB |");
    expect(comment).toContain("<summary>Added (1)</summary>");
    expect(comment).not.toContain("<summary>Removed");
    expect(comment).not.toContain("```");
  });

  test("escapes pipes so table cells stay intact", () => {
    const comment = formatAggregatedComment(
      [
        jsonResult(
          report([
            pkg({
              name: "a|b",
              status: "Added",
              versions: [{ kind: "added", version: { name: "1", amount: 1 } }],
            }),
          ]),
        ),
      ],
      "sha",
    );
    expect(comment).toContain("| `a\\|b` | `1` |");
  });

  test("states that nothing changed when the report has no package diffs", () => {
    const comment = formatAggregatedComment([jsonResult(report([]))], "sha");
    expect(comment).toContain("No package additions, removals, or version changes.");
    expect(comment).not.toContain("<details>");
  });

  test("drops whole rows to stay under the comment limit", () => {
    const many = Array.from({ length: 3000 }, (_, i) =>
      pkg({
        name: `package-with-a-long-name-${i}`,
        status: "Upgraded",
        versions: [
          {
            kind: "changed",
            old: { name: "1.0.0", amount: 1 },
            new: { name: "1.0.1", amount: 1 },
          },
        ],
      }),
    );
    const comment = formatAggregatedComment([jsonResult(report(many))], "sha");

    expect(comment.length).toBeLessThan(65536);
    expect(comment).toMatch(/\d+ more packages not shown/);
    expect(comment).toContain("<summary>Changed (3000)</summary>");
  });

  test("gives every package group a share of the budget when one group is long", () => {
    const upgraded = Array.from({ length: 3000 }, (_, i) =>
      pkg({
        name: `package-with-a-long-name-${i}`,
        status: "Upgraded",
        versions: [
          {
            kind: "changed",
            old: { name: "1.0.0", amount: 1 },
            new: { name: "1.0.1", amount: 1 },
          },
        ],
      }),
    );
    const removed = Array.from({ length: 3000 }, (_, i) =>
      pkg({
        name: `gone-${i}`,
        status: "Removed",
        versions: [{ kind: "removed", version: { name: "1.0", amount: 1 } }],
      }),
    );
    const comment = formatAggregatedComment([jsonResult(report([...upgraded, ...removed]))], "sha");

    expect(comment.length).toBeLessThan(65536);
    expect(comment).toContain("<summary>Removed (3000)</summary>");
    expect(comment).toContain("| `gone-0` |");
  });

  test("caps the versions listed per side in the comment", () => {
    const comment = formatAggregatedComment(
      [
        jsonResult(
          report([
            pkg({
              name: "CVE",
              status: "Changed",
              versions: Array.from({ length: 8 }, (_, i) => ({
                kind: "added" as const,
                version: { name: `${i}.patch`, amount: 1 },
              })),
            }),
          ]),
        ),
      ],
      "sha",
    );
    expect(comment).toContain(
      "| `CVE` | `∅ → 0.patch, 1.patch, 2.patch, 3.patch, 4.patch, +3 more` |",
    );
  });

  test("drops whole trailing attributes when their markup alone exceeds the limit", () => {
    const results = Array.from({ length: 400 }, (_, i) => ({
      ...jsonResult(report([])),
      displayName: `host${i}`,
    }));
    const comment = formatAggregatedComment(results, "sha");

    expect(comment.length).toBeLessThan(65536);
    expect(comment).toContain("### host0");
    expect(comment).not.toContain("### host399");
    expect(comment).toMatch(/\d+ more attributes not shown/);
    expect(comment).toContain("<!-- nix-diff-action-footer sha=sha -->");
  });

  test("stays under the comment limit with many attributes each carrying markup", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      pkg({
        name: `package-${i}`,
        status: "Upgraded",
        versions: [
          {
            kind: "changed",
            old: { name: "1.0.0", amount: 1 },
            new: { name: "1.0.1", amount: 1 },
          },
        ],
      }),
    );
    const results = Array.from({ length: 50 }, (_, i) => ({
      ...jsonResult(report(rows)),
      displayName: `host${i}`,
    }));
    const comment = formatAggregatedComment(results, "sha", {
      repoUrl: "https://github.com/owner/repo",
      runId: "12345",
      htmlViewerAvailable: true,
    });

    expect(comment.length).toBeLessThan(65536);
    expect(comment).toContain("### host49");
  });
});

describe("slugify", () => {
  test("lowercases and hyphenates non-alphanumeric runs", () => {
    expect(slugify("Host 1")).toBe("host-1");
    expect(slugify("my.app:prod")).toBe("my-app-prod");
  });

  test("falls back to 'diff' on input that produces an empty slug", () => {
    expect(slugify("...")).toBe("diff");
    expect(slugify("")).toBe("diff");
  });
});

describe("generateDiffHtml", () => {
  const baseResult = {
    displayName: "host1",
    attributePath: "nixosConfigurations.host1.config.system.build.toplevel",
    baseRef: "abc123",
    prRef: "def456",
    basePath: "/nix/store/aaa-base",
    prPath: "/nix/store/bbb-pr",
    diff: textOutput(`<<< /nix/store/abc-old.drv
>>> /nix/store/def-new.drv

ADDED
[A.] pkg-new   1.0

SIZE: 10.0 MiB -> 12.0 MiB`),
  };

  test("renders a valid HTML document with core metadata", () => {
    const html = generateDiffHtml([baseResult]);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Nix Diff Results</title>");
    expect(html).toContain("1 comparison");
    expect(html).toContain("nixosConfigurations.host1.config.system.build.toplevel");
    expect(html).toContain("ADDED");
    expect(html).toContain("pkg-new");
    expect(html).toContain("10.0 MiB");
  });

  test("escapes HTML-sensitive characters in user-controlled fields", () => {
    const html = generateDiffHtml([
      {
        displayName: "<script>alert(1)</script>",
        attributePath: "a&b",
        baseRef: "<base>",
        prRef: "<pr>",
        basePath: "/nix/store/aaa-base",
        prPath: "/nix/store/bbb-pr",
        diff: textOutput("plain"),
      },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a&amp;b");
  });

  test("uses singular/plural comparison label correctly", () => {
    const pluralHtml = generateDiffHtml([baseResult, baseResult]);
    expect(pluralHtml).toContain("2 comparisons");
  });

  test("renders an empty document gracefully when there are no results", () => {
    const html = generateDiffHtml([]);
    expect(html).toContain("0 comparisons");
    // With zero results there is no summary table to render.
    expect(html).not.toContain('<table class="summary-table">');
  });
});
