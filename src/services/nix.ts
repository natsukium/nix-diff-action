import * as exec from "@actions/exec";
import { Effect, Ref } from "effect";
import { NixPathInfoError, NixDixError } from "../errors.js";

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

      getNixPath: (flakeRef: string, build: boolean): Effect.Effect<string, NixPathInfoError> =>
        Effect.gen(function* () {
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

      // Security: inputsFromPath must reference the base branch worktree, not the PR branch.
      // Using the PR branch's flake.lock would allow attackers to inject a malicious nixpkgs
      // fork that replaces dix with arbitrary code, which would then execute in the CI environment
      // with access to GITHUB_TOKEN and other secrets.
      getDixDiff: (
        basePath: string,
        prPath: string,
        inputsFromPath: string,
      ): Effect.Effect<string, NixDixError> =>
        Effect.gen(function* () {
          // Use path: to avoid git history requirements
          const inputsFromRef = `path:${inputsFromPath}`;
          const { exitCode, stdout, stderr } = yield* execNix([
            "run",
            "nixpkgs#dix",
            "--inputs-from",
            inputsFromRef,
            "--",
            basePath,
            prPath,
          ]);

          if (exitCode !== 0) {
            return yield* Effect.fail(
              new NixDixError({
                basePath,
                prPath,
                message: stderr || "dix failed with no error message",
              }),
            );
          }

          if (stderr) {
            yield* Effect.logInfo(`dix stderr: ${stderr}`);
          }
          return stdout;
        }),
    };
  }),
}) {}
