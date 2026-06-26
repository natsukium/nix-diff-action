import { describe, expect, test, vi, beforeEach } from "vitest";
import * as fs from "fs";
import { Effect } from "effect";
import type { DiffResult } from "../schemas.js";

// Mutable state shared with the mocked artifact client. Named with a "mock"
// prefix so vitest allows the hoisted vi.mock factory to reference it.
const mockState: {
  artifacts: { id: number; name: string }[];
  contentById: Record<number, DiffResult[]>;
} = { artifacts: [], contentById: {} };

// Mock @actions/artifact so the real download/upload network calls are replaced
// with local-filesystem behavior that mirrors how the real client extracts an
// artifact archive: every archive contains a file named "result.json" that is
// written into the caller-provided download path.
vi.mock("@actions/artifact", () => {
  // The @actions/artifact client is a Promise-based boundary, so the mock
  // returns plain Promises rather than wrapping values in Effect.
  const makeClient = () => ({
    listArtifacts: () => Promise.resolve({ artifacts: mockState.artifacts }),
    downloadArtifact: async (id: number, opts: { path: string }) => {
      // Yield once so every concurrent download is in flight before any of
      // them writes. This deterministically exposes the shared-path race:
      // with all archives extracting "result.json" into the same directory,
      // the last writer wins and every reader observes that single file.
      await Promise.resolve();
      fs.mkdirSync(opts.path, { recursive: true });
      fs.writeFileSync(`${opts.path}/result.json`, JSON.stringify(mockState.contentById[id]));
      return { downloadPath: opts.path };
    },
    uploadArtifact: () => Promise.resolve({}),
  });
  // `new DefaultArtifactClient()` in the source needs a constructable value;
  // a function that returns an object satisfies that without OOP class syntax.
  return {
    DefaultArtifactClient: function DefaultArtifactClient() {
      return makeClient();
    },
  };
});

const { ArtifactService } = await import("./artifact.js");

const makeResult = (host: string): DiffResult => ({
  displayName: host,
  attributePath: `nixosConfigurations.${host}.config.system.build.toplevel`,
  baseRef: "abc123",
  prRef: "def456",
  diff: `diff for ${host}`,
});

describe("downloadAllDiffResults", () => {
  beforeEach(() => {
    mockState.artifacts = [];
    mockState.contentById = {};
  });

  // Reproduces https://github.com/natsukium/nix-diff-action/issues/51:
  // in split mode with a parallel matrix, hosts are randomly skipped and/or
  // duplicated. Each matrix leg uploads its own "diff-result-*" artifact, but
  // the aggregator downloads them all concurrently into one shared directory,
  // where the identically-named "result.json" entries clobber each other.
  test("returns every host exactly once across parallel matrix artifacts", async () => {
    const hosts = ["host1", "host2", "host3", "host4", "host5"];
    mockState.artifacts = hosts.map((host, i) => ({
      id: i + 1,
      name: `diff-result-${host}-aaaaaa`,
    }));
    hosts.forEach((host, i) => {
      mockState.contentById[i + 1] = [makeResult(host)];
    });

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* ArtifactService;
        return yield* svc.downloadAllDiffResults("token", 123, "owner", "repo");
      }).pipe(Effect.provide(ArtifactService.Default)),
    );

    const got = results.map((r) => r.displayName).sort();
    expect(got).toEqual([...hosts].sort());
  });
});
