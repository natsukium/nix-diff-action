import * as exec from "@actions/exec";
import { Data, Effect, Ref } from "effect";
import { NixPathInfoError, NixDixError, NixBuildError } from "../errors.js";

class DixUnsupportedFlag extends Data.TaggedError("DixUnsupportedFlag")<{}> {}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Execute nix command and collect output
// Uses mutable arrays outside Effect to avoid Effect.runSync in callbacks,
// which breaks Effect's composability guarantees
// Returns ExecResult with exitCode -1 if exec itself fails (e.g., nix binary not found)
const execNix = (args: string[], ignoreReturnCode = true): Effect.Effect<ExecResult, never> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  return Effect.tryPromise({
    try: () =>
      exec.exec("nix", args, {
        listeners: {
          stdout: (data: Buffer) => {
            stdoutChunks.push(data.toString());
          },
          stderr: (data: Buffer) => {
            stderrChunks.push(data.toString());
          },
        },
        ignoreReturnCode,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning(`nix exec failed unexpectedly: ${error}`).pipe(Effect.as(-1)),
    ),
    Effect.map((exitCode) => ({
      exitCode,
      stdout: stdoutChunks.join("").trim(),
      stderr: stderrChunks.join("").trim(),
    })),
  );
};

const execPrefetch = (flakeRef: string) =>
  Effect.tryPromise({
    try: () =>
      exec.exec("nix", ["flake", "prefetch-inputs", flakeRef], {
        ignoreReturnCode: true,
        listeners: { stderr: () => {} },
      }),
    catch: () => new Error("prefetch failed"),
  }).pipe(Effect.orElseSucceed(() => 1));

export class NixService extends Effect.Service<NixService>()("NixService", {
  effect: Effect.gen(function* () {
    const prefetchLogged = yield* Ref.make(false);

    return {
      prefetchFlakeInputs: (flakeRef: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const exitCode = yield* execPrefetch(flakeRef);
          if (exitCode !== 0) {
            const alreadyLogged = yield* Ref.get(prefetchLogged);
            if (!alreadyLogged) {
              yield* Ref.set(prefetchLogged, true);
              yield* Effect.logInfo(
                "Skipping parallel input fetch: nix flake prefetch-inputs requires Nix 2.31.0+",
              );
            }
          }
        }),

      getNixPath: (
        flakeRef: string,
        build: boolean,
      ): Effect.Effect<string, NixPathInfoError | NixBuildError> =>
        Effect.gen(function* () {
          // nix path-info does not build or substitute, so we need to build first
          // when build mode is enabled
          if (build) {
            const buildResult = yield* execNix(["build", flakeRef, "--no-link"]);
            if (buildResult.exitCode !== 0) {
              return yield* Effect.fail(
                new NixBuildError({
                  flakeRef,
                  message: buildResult.stderr || "unknown error",
                }),
              );
            }
          }

          const args = build ? ["path-info", flakeRef] : ["path-info", "--derivation", flakeRef];
          const { exitCode, stdout, stderr } = yield* execNix(args);

          if (exitCode !== 0) {
            return yield* Effect.fail(
              new NixPathInfoError({
                flakeRef,
                message: stderr || "unknown error",
              }),
            );
          }

          if (!stdout) {
            return yield* Effect.fail(
              new NixPathInfoError({
                flakeRef,
                message: "nix path-info returned empty output",
              }),
            );
          }

          return stdout;
        }),

      // Security: inputsFromRef must reference the base branch worktree, not the PR branch.
      // Using the PR branch's flake.lock would allow attackers to inject a malicious nixpkgs
      // fork that replaces dix with arbitrary code, which would then execute in the CI environment
      // with access to GITHUB_TOKEN and other secrets.
      getDixDiff: (
        basePath: string,
        prPath: string,
        inputsFromRef: string,
      ): Effect.Effect<string, NixDixError> => {
        const baseArgs = ["run", "nixpkgs#dix", "--inputs-from", inputsFromRef, "--"];

        const handleDixResult = (result: ExecResult) => {
          if (result.exitCode !== 0) {
            return Effect.fail(
              new NixDixError({
                basePath,
                prPath,
                message: result.stderr || "dix failed with no error message",
              }),
            );
          }
          if (result.stderr) {
            return Effect.logInfo(`dix stderr: ${result.stderr}`).pipe(Effect.as(result.stdout));
          }
          return Effect.succeed(result.stdout);
        };

        // Try with --force-correctness (dix 1.4.2+) first, fall back to
        // without it for older versions that don't recognize the flag.
        return execNix([...baseArgs, "--force-correctness", basePath, prPath]).pipe(
          Effect.flatMap((result) =>
            result.exitCode !== 0 &&
            result.stderr.includes("unexpected argument '--force-correctness'")
              ? Effect.fail(new DixUnsupportedFlag())
              : Effect.succeed(result),
          ),
          Effect.catchTag("DixUnsupportedFlag", () =>
            Effect.logInfo("dix does not support --force-correctness, retrying without it").pipe(
              Effect.andThen(execNix([...baseArgs, basePath, prPath])),
            ),
          ),
          Effect.flatMap(handleDixResult),
        );
      },
    };
  }),
}) {}
