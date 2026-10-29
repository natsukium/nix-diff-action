import * as exec from "@actions/exec";
import { Effect, Either, Ref, Schema } from "effect";
import { NixPathInfoError, NixDixError, NixBuildError } from "../errors.js";
import { DixReport, type DixOutput } from "../schemas.js";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Execute a command and collect output
// Uses mutable arrays outside Effect to avoid Effect.runSync in callbacks,
// which breaks Effect's composability guarantees
// Returns ExecResult with exitCode -1 if exec itself fails (e.g., binary not found)
const execCommand = (
  command: string,
  args: string[],
  ignoreReturnCode = true,
): Effect.Effect<ExecResult, never> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  return Effect.tryPromise({
    try: () =>
      exec.exec(command, args, {
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
      Effect.logWarning(`${command} exec failed unexpectedly: ${error}`).pipe(Effect.as(-1)),
    ),
    Effect.map((exitCode) => ({
      exitCode,
      stdout: stdoutChunks.join("").trim(),
      stderr: stderrChunks.join("").trim(),
    })),
  );
};

const execNix = (args: string[], ignoreReturnCode = true) =>
  execCommand("nix", args, ignoreReturnCode);

const execPrefetch = (flakeRef: string) =>
  Effect.tryPromise({
    try: () =>
      exec.exec("nix", ["flake", "prefetch-inputs", flakeRef], {
        ignoreReturnCode: true,
        listeners: { stderr: () => {} },
      }),
    catch: () => new Error("prefetch failed"),
  }).pipe(Effect.orElseSucceed(() => 1));

export type DixCli = {
  version: string;
  json?: (oldPath: string, newPath: string) => string[];
  text: (oldPath: string, newPath: string) => string[];
};

// The dix version comes from the user's nixpkgs, so every CLI generation that
// nixpkgs has shipped must keep working:
// - 3.x: `dix diff [--output json] OLD NEW`; --force-correctness is gone
// - 2.x: `dix [--force-correctness] [--output json] OLD NEW`
// - 1.x: `dix [--force-correctness] OLD NEW`, no JSON (the flag is 1.4.2+)
// An unrecognized version string is treated as the newest CLI.
export const selectDixCli = (versionOutput: string): DixCli => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) {
    return {
      version: "unknown",
      json: (o, n) => ["diff", "--output", "json", o, n],
      text: (o, n) => ["diff", o, n],
    };
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  const version = match[0];
  if (major >= 3) {
    return {
      version,
      json: (o, n) => ["diff", "--output", "json", o, n],
      text: (o, n) => ["diff", o, n],
    };
  }
  if (major === 2) {
    return {
      version,
      json: (o, n) => ["--force-correctness", "--output", "json", o, n],
      text: (o, n) => ["--force-correctness", o, n],
    };
  }
  const forceCorrectness = minor > 4 || (minor === 4 && patch >= 2) ? ["--force-correctness"] : [];
  return { version, text: (o, n) => [...forceCorrectness, o, n] };
};

export const decodeDixReport = (stdout: string): Either.Either<DixReport, string> =>
  Either.try({
    try: () => JSON.parse(stdout) as unknown,
    catch: (e) => `invalid JSON: ${e}`,
  }).pipe(
    Either.flatMap((json) =>
      Schema.decodeUnknownEither(DixReport)(json).pipe(Either.mapLeft((e) => e.message)),
    ),
  );

type ResolvedDix = { bin: string; cli: DixCli };

export class NixService extends Effect.Service<NixService>()("NixService", {
  effect: Effect.gen(function* () {
    const prefetchLogged = yield* Ref.make(false);
    const resolvedDix = yield* Ref.make(new Map<string, ResolvedDix>());

    // Build dix once per inputsFromRef and run the binary directly, so its
    // version can be probed before choosing arguments and every attribute
    // reuses the same evaluation.
    const resolveDix = (
      inputsFromRef: string,
      basePath: string,
      prPath: string,
    ): Effect.Effect<ResolvedDix, NixDixError> =>
      Effect.gen(function* () {
        const cached = (yield* Ref.get(resolvedDix)).get(inputsFromRef);
        if (cached) return cached;

        const build = yield* execNix([
          "build",
          "nixpkgs#dix",
          "--inputs-from",
          inputsFromRef,
          "--no-link",
          "--print-out-paths",
        ]);
        const outPath = build.stdout.split("\n")[0];
        if (build.exitCode !== 0 || !outPath) {
          return yield* Effect.fail(
            new NixDixError({
              basePath,
              prPath,
              message: `failed to build dix: ${build.stderr || "unknown error"}`,
            }),
          );
        }

        const bin = `${outPath}/bin/dix`;
        const versionResult = yield* execCommand(bin, ["--version"]);
        const cli = selectDixCli(versionResult.stdout);
        yield* Effect.logInfo(`Using dix ${cli.version} (${outPath})`);

        const resolved = { bin, cli };
        yield* Ref.update(resolvedDix, (m) => new Map(m).set(inputsFromRef, resolved));
        return resolved;
      });

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
      ): Effect.Effect<DixOutput, NixDixError> =>
        Effect.gen(function* () {
          const { bin, cli } = yield* resolveDix(inputsFromRef, basePath, prPath);

          const runDix = (args: string[]) =>
            execCommand(bin, args).pipe(
              Effect.flatMap((result) => {
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
                  return Effect.logInfo(`dix stderr: ${result.stderr}`).pipe(
                    Effect.as(result.stdout),
                  );
                }
                return Effect.succeed(result.stdout);
              }),
            );

          if (cli.json) {
            const stdout = yield* runDix(cli.json(basePath, prPath));
            const decoded = decodeDixReport(stdout);
            if (Either.isRight(decoded)) {
              return { format: "json" as const, report: decoded.right };
            }
            yield* Effect.logWarning(
              `dix ${cli.version} JSON output did not match the expected schema, falling back to human-readable output: ${decoded.left}`,
            );
          }

          const text = yield* runDix(cli.text(basePath, prPath));
          return { format: "text" as const, text };
        }),
    };
  }),
}) {}
