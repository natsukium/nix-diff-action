import { describe, expect, test } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { formatAggregatedComment, truncateDiff, sanitizeDisplayName } from "./services/github.js";
import { parseCommentStrategy, parseAttributes, validateDirectory } from "./programs/index.js";
import { processDiffResults } from "./programs/full.js";
import { GitService, sanitizeBranchName } from "./services/git.js";
import { NixService } from "./services/nix.js";
import { createArtifactName } from "./services/artifact.js";

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
        diff: "some diff output",
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
    expect(comment).toContain("[dix](https://github.com/faukah/dix)");
  });

  test("formats multiple results with generic marker", () => {
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        diff: "diff1",
      },
      {
        displayName: "host2",
        attributePath: "nixosConfigurations.host2...",
        baseRef: "github:owner/repo",
        prRef: ".",
        diff: "diff2",
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
        diff: largeDiff,
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
        diff: largeDiff,
      },
      {
        displayName: "host2",
        attributePath: "nixosConfigurations.host2...",
        baseRef: "github:owner/repo",
        prRef: ".",
        diff: largeDiff,
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456");

    // Both diffs should be truncated since 50000 * 2 > 60000 limit
    expect((comment.match(/truncated/g) || []).length).toBe(2);
    expect(comment.length).toBeLessThan(65536);
  });

  test("keeps total comment under limit with many attributes", () => {
    const largeDiff = "c".repeat(30000);
    const results = Array.from({ length: 5 }, (_, i) => ({
      displayName: `host${i + 1}`,
      attributePath: `nixosConfigurations.host${i + 1}...`,
      baseRef: "github:owner/repo",
      prRef: ".",
      diff: largeDiff,
    }));
    const comment = formatAggregatedComment(results, "abc123def456");

    expect(comment.length).toBeLessThan(65536);
  });

  test("includes artifact link when truncated and options provided", () => {
    const largeDiff = "d".repeat(70000);
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        diff: largeDiff,
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456", {
      runId: "12345",
      repoUrl: "https://github.com/owner/repo",
    });

    expect(comment).toContain("View full diff in artifacts");
    expect(comment).toContain("https://github.com/owner/repo/actions/runs/12345");
  });

  test("does not include artifact link when not truncated", () => {
    const smallDiff = "small diff";
    const results = [
      {
        displayName: "host1",
        attributePath: "nixosConfigurations.host1...",
        baseRef: "github:owner/repo",
        prRef: ".",
        diff: smallDiff,
      },
    ];
    const comment = formatAggregatedComment(results, "abc123def456", {
      runId: "12345",
      repoUrl: "https://github.com/owner/repo",
    });

    expect(comment).not.toContain("View full diff in artifacts");
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

  const createMockNixService = (capturedFlakeRefs: string[], capturedInputsFromPaths?: string[]) =>
    Layer.succeed(
      NixService,
      new NixService({
        prefetchFlakeInputs: () => Effect.void,
        getNixPath: (flakeRef: string) => {
          capturedFlakeRefs.push(flakeRef);
          return Effect.succeed(`/nix/store/mock-hash`);
        },
        getDixDiff: (_basePath: string, _prPath: string, inputsFromPath: string) => {
          capturedInputsFromPaths?.push(inputsFromPath);
          return Effect.succeed("mock diff output");
        },
      }),
    );

  test("constructs correct paths when directory equals cwd", async () => {
    const worktreePath = "/tmp/dix-base-main";
    const directory = "/workspace/repo";
    const cwd = "/workspace/repo";
    const capturedFlakeRefs: string[] = [];
    const capturedInputsFromPaths: string[] = [];

    const mockGit = createMockGitService(worktreePath);
    const mockNix = createMockNixService(capturedFlakeRefs, capturedInputsFromPaths);
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
    expect(result[0].diff).toBe("mock diff output");

    // Verify getNixPath was called with correct flake refs
    expect(capturedFlakeRefs).toContain("path:/tmp/dix-base-main#packages.x86_64-linux.default");
    expect(capturedFlakeRefs).toContain("/workspace/repo#packages.x86_64-linux.default");

    // Security: Verify getDixDiff uses base branch worktree path (not PR branch)
    // This prevents malicious flake.lock in PR from injecting compromised dix
    expect(capturedInputsFromPaths).toEqual([worktreePath]);
  });

  test("constructs correct paths for subdirectory", async () => {
    const worktreePath = "/tmp/dix-base-main";
    const directory = "/workspace/repo/packages/myflake";
    const cwd = "/workspace/repo";
    const capturedFlakeRefs: string[] = [];

    const mockGit = createMockGitService(worktreePath);
    const mockNix = createMockNixService(capturedFlakeRefs);
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
