import { describe, expect, test, vi, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import { NixService } from "./nix.js";

type MockCall = { command: string; args: string[] };
type MockReply = { exitCode: number; stdout?: string; stderr?: string };

const mockState: {
  calls: MockCall[];
  reply: (call: MockCall) => MockReply;
} = { calls: [], reply: () => ({ exitCode: 0 }) };

vi.mock("@actions/exec", () => ({
  exec: (
    command: string,
    args: string[],
    opts: { listeners?: { stdout?: (b: Buffer) => void; stderr?: (b: Buffer) => void } },
  ) => {
    const call = { command, args };
    mockState.calls.push(call);
    const { exitCode, stdout, stderr } = mockState.reply(call);
    if (stdout) opts.listeners?.stdout?.(Buffer.from(stdout));
    if (stderr) opts.listeners?.stderr?.(Buffer.from(stderr));
    return Promise.resolve(exitCode);
  },
}));

const DIX_OUT = "/nix/store/aaaa-dix";
const DIX_BIN = `${DIX_OUT}/bin/dix`;
const INPUTS_FROM = "path:/tmp/base-worktree";

const REPORT = JSON.stringify({
  diffs: [],
  paths: { old: 1, new: 1, added: 0, removed: 0 },
  size_old: 0,
  size_new: 0,
});

const fakeDix =
  (version: string, run: (args: string[]) => MockReply) =>
  ({ command, args }: MockCall): MockReply => {
    if (command === "nix") return { exitCode: 0, stdout: `${DIX_OUT}\n` };
    if (args[0] === "--version") return { exitCode: 0, stdout: `dix ${version}\n` };
    return run(args);
  };

const getDixDiff = (basePath = "/nix/store/old", prPath = "/nix/store/new") =>
  Effect.gen(function* () {
    const nix = yield* NixService;
    return yield* nix.getDixDiff(basePath, prPath, INPUTS_FROM);
  }).pipe(Effect.provide(NixService.Default));

const dixCalls = () =>
  mockState.calls.filter((c) => c.command === DIX_BIN && c.args[0] !== "--version");

beforeEach(() => {
  mockState.calls = [];
});

describe("NixService.getDixDiff", () => {
  test("builds dix from the given inputs-from reference and probes its version", async () => {
    mockState.reply = fakeDix("3.0.0", () => ({ exitCode: 0, stdout: REPORT }));

    await Effect.runPromise(getDixDiff());

    expect(mockState.calls[0]).toEqual({
      command: "nix",
      args: [
        "build",
        "nixpkgs#dix",
        "--inputs-from",
        INPUTS_FROM,
        "--no-link",
        "--print-out-paths",
      ],
    });
    expect(mockState.calls[1]).toEqual({ command: DIX_BIN, args: ["--version"] });
  });

  test("dix 3 is invoked with the diff subcommand and JSON output, without --force-correctness", async () => {
    mockState.reply = fakeDix("3.0.0", () => ({ exitCode: 0, stdout: REPORT }));

    const result = await Effect.runPromise(getDixDiff());

    expect(dixCalls().map((c) => c.args)).toEqual([
      ["diff", "--output", "json", "/nix/store/old", "/nix/store/new"],
    ]);
    expect(result.format).toBe("json");
  });

  test("dix 2 is invoked with --force-correctness and JSON output", async () => {
    mockState.reply = fakeDix("2.0.0", () => ({ exitCode: 0, stdout: REPORT }));

    const result = await Effect.runPromise(getDixDiff());

    expect(dixCalls().map((c) => c.args)).toEqual([
      ["--force-correctness", "--output", "json", "/nix/store/old", "/nix/store/new"],
    ]);
    expect(result.format).toBe("json");
  });

  test("dix 1.x is invoked once for human-readable output", async () => {
    mockState.reply = fakeDix("1.4.2", () => ({ exitCode: 0, stdout: "<<< /nix/store/old" }));

    const result = await Effect.runPromise(getDixDiff());

    expect(dixCalls().map((c) => c.args)).toEqual([
      ["--force-correctness", "/nix/store/old", "/nix/store/new"],
    ]);
    expect(result).toEqual({ format: "text", text: "<<< /nix/store/old" });
  });

  test("JSON output that does not match the schema triggers a human-readable rerun", async () => {
    mockState.reply = fakeDix("3.0.0", (args) =>
      args.includes("json")
        ? { exitCode: 0, stdout: '{"unexpected":true}' }
        : { exitCode: 0, stdout: "CHANGED\n[U.] foo  1 -> 2" },
    );

    const result = await Effect.runPromise(getDixDiff());

    expect(dixCalls().map((c) => c.args)).toEqual([
      ["diff", "--output", "json", "/nix/store/old", "/nix/store/new"],
      ["diff", "/nix/store/old", "/nix/store/new"],
    ]);
    expect(result).toEqual({ format: "text", text: "CHANGED\n[U.] foo  1 -> 2" });
  });

  test("a nonzero dix exit fails with its stderr instead of falling back", async () => {
    mockState.reply = fakeDix("3.0.0", () => ({ exitCode: 2, stderr: "error: boom" }));

    const exit = await Effect.runPromiseExit(getDixDiff());

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("error: boom");
    expect(dixCalls()).toHaveLength(1);
  });

  test("a failed dix build fails without running dix", async () => {
    mockState.reply = ({ command }) =>
      command === "nix" ? { exitCode: 1, stderr: "attribute 'dix' missing" } : { exitCode: 0 };

    const exit = await Effect.runPromiseExit(getDixDiff());

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("attribute 'dix' missing");
    expect(mockState.calls.every((c) => c.command === "nix")).toBe(true);
  });

  test("dix is built once per inputs-from reference across attributes", async () => {
    mockState.reply = fakeDix("3.0.0", () => ({ exitCode: 0, stdout: REPORT }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const nix = yield* NixService;
        yield* nix.getDixDiff("/nix/store/a", "/nix/store/b", INPUTS_FROM);
        yield* nix.getDixDiff("/nix/store/c", "/nix/store/d", INPUTS_FROM);
      }).pipe(Effect.provide(NixService.Default)),
    );

    expect(mockState.calls.filter((c) => c.command === "nix")).toHaveLength(1);
    expect(dixCalls()).toHaveLength(2);
  });
});
