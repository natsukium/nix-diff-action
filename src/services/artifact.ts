import { DefaultArtifactClient } from "@actions/artifact";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as nodePath from "path";
import * as os from "os";
import { Cause, Effect, Option, Schema, Scope } from "effect";
import { ArtifactError } from "../errors.js";
import { DiffResult, DiffResultArray } from "../schemas.js";
import { generateDiffHtml } from "./html.js";

const artifactClient = new DefaultArtifactClient();

type FindBy = {
  token: string;
  workflowRunId: number;
  repositoryOwner: string;
  repositoryName: string;
};

// Convert error to Option.None with warning log.
// Effect.option handles the Success -> Some / Failure -> None conversion;
// tapError adds the warning log without altering the error channel.
const withWarningOption = <A, E>(
  effect: Effect.Effect<A, E>,
  context: string,
): Effect.Effect<Option.Option<A>, never> =>
  effect.pipe(
    Effect.tapError((error) => Effect.logWarning(`${context}: ${JSON.stringify(error)}`)),
    Effect.option,
  );

const downloadArtifact = (artId: number, artName: string, downloadPath: string, findBy: FindBy) =>
  Effect.tryPromise({
    try: () =>
      artifactClient.downloadArtifact(artId, {
        path: downloadPath,
        findBy,
      }),
    catch: (e) =>
      new ArtifactError({
        name: artName,
        message: `Failed to download artifact: ${e}`,
      }),
  });

const readResultFile = (downloadPath: string, artName: string) =>
  Effect.tryPromise({
    try: () => fs.readFile(nodePath.join(downloadPath, "result.json"), "utf-8"),
    catch: (e) =>
      new ArtifactError({
        name: artName,
        message: `Failed to read result file: ${e}`,
      }),
  });

const parseJson = (content: string, artName: string) =>
  Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: (e) =>
      new ArtifactError({
        name: artName,
        message: `Failed to parse JSON: ${e}`,
      }),
  });

const decodeResults = (parsed: unknown, artName: string) =>
  Schema.decodeUnknown(DiffResultArray)(parsed).pipe(
    Effect.mapError(
      (error) =>
        new ArtifactError({
          name: artName,
          message: `Invalid format: ${error}`,
        }),
    ),
  );

const downloadAndParseArtifact = (
  art: { id: number; name: string },
  downloadPath: string,
  findBy: FindBy,
): Effect.Effect<readonly DiffResult[], never> =>
  Effect.gen(function* () {
    const resultOption = yield* withWarningOption(
      downloadArtifact(art.id, art.name, downloadPath, findBy),
      `Download artifact ${art.name}`,
    );

    const artifactDownloadPath = resultOption.pipe(
      Option.flatMap((r) => Option.fromNullable(r.downloadPath)),
    );

    if (Option.isNone(artifactDownloadPath)) {
      yield* Effect.logWarning(`Artifact ${art.name} has no download path`);
      return [] as readonly DiffResult[];
    }

    const contentOption = yield* withWarningOption(
      readResultFile(artifactDownloadPath.value, art.name),
      `Read artifact ${art.name}`,
    );

    if (Option.isNone(contentOption)) {
      return [] as readonly DiffResult[];
    }

    const parsedOption = yield* withWarningOption(
      parseJson(contentOption.value, art.name),
      `Parse artifact ${art.name}`,
    );

    if (Option.isNone(parsedOption)) {
      return [] as readonly DiffResult[];
    }

    return yield* decodeResults(parsedOption.value, art.name).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`Decode artifact ${art.name}: ${String(error)}`).pipe(
          Effect.as([] as readonly DiffResult[]),
        ),
      ),
    );
  });

export const createArtifactName = (displayName: string) => {
  const sanitizedId = displayName.replace(/[^a-zA-Z0-9-_]/g, "-");
  const hash = crypto.createHash("sha256").update(displayName).digest("hex").slice(0, 6);
  return `diff-result-${sanitizedId}-${hash}`;
};

// JSON is the machine-readable payload that matrix legs pass to the aggregator.
// HTML is the human-readable view. JSON must be archived because GitHub Actions
// requires that for inter-job data transfer; HTML is skipArchive so it can be
// opened directly from the Artifacts UI.
const HTML_ARTIFACT_NAME = "diff-view.html";

// Acquire a temp directory whose cleanup is tied to the surrounding Scope, so
// callers get automatic removal on success, failure, or interruption.
// The release must be Effect<_, never, _>; we fold any rejection (including
// defects) into a warning log via catchAllCause so cleanup never fails the scope.
const withTempDir = (
  prefix: string,
  errorName: string,
): Effect.Effect<string, ArtifactError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => fs.mkdtemp(nodePath.join(os.tmpdir(), prefix)),
      catch: (e) =>
        new ArtifactError({
          name: errorName,
          message: `Failed to create temp directory: ${e}`,
        }),
    }),
    (dir) =>
      Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(`Failed to clean up temp directory ${dir}: ${Cause.pretty(cause)}`),
        ),
      ),
  );

export class ArtifactService extends Effect.Service<ArtifactService>()("ArtifactService", {
  succeed: {
    uploadJsonResult: (
      results: readonly DiffResult[],
      displayName: string,
    ): Effect.Effect<void, ArtifactError> => {
      const artifactName = createArtifactName(displayName);

      return Effect.scoped(
        Effect.gen(function* () {
          const tempDir = yield* withTempDir("dix-", artifactName);
          const resultPath = nodePath.join(tempDir, "result.json");

          yield* Effect.tryPromise({
            try: () => fs.writeFile(resultPath, JSON.stringify(results, null, 2)),
            catch: (e) =>
              new ArtifactError({
                name: artifactName,
                message: `Failed to write results file: ${e}`,
              }),
          });

          yield* Effect.tryPromise({
            try: () => artifactClient.uploadArtifact(artifactName, [resultPath], tempDir),
            catch: (e) =>
              new ArtifactError({
                name: artifactName,
                message: `Failed to upload artifact: ${e}`,
              }),
          });

          yield* Effect.logInfo(`Uploaded artifact: ${artifactName}`);
        }),
      );
    },

    // Returns true when the HTML artifact was actually uploaded so callers can
    // decide whether it is safe to advertise the viewer link in the PR comment.
    // Returns false for the "no results" short-circuit. Upload errors surface
    // via the error channel and are handled by callers.
    uploadAggregatedHtml: (results: readonly DiffResult[]): Effect.Effect<boolean, ArtifactError> =>
      Effect.scoped(
        Effect.gen(function* () {
          if (results.length === 0) {
            yield* Effect.logInfo("No diff results to render as HTML; skipping HTML artifact");
            return false;
          }

          const tempDir = yield* withTempDir("dix-html-", HTML_ARTIFACT_NAME);
          const htmlPath = nodePath.join(tempDir, HTML_ARTIFACT_NAME);

          yield* Effect.tryPromise({
            try: () => fs.writeFile(htmlPath, generateDiffHtml(results)),
            catch: (e) =>
              new ArtifactError({
                name: HTML_ARTIFACT_NAME,
                message: `Failed to write HTML file: ${e}`,
              }),
          });

          yield* Effect.tryPromise({
            try: () =>
              artifactClient.uploadArtifact(HTML_ARTIFACT_NAME, [htmlPath], tempDir, {
                skipArchive: true,
              }),
            catch: (e) =>
              new ArtifactError({
                name: HTML_ARTIFACT_NAME,
                message: `Failed to upload HTML artifact: ${e}`,
              }),
          });

          yield* Effect.logInfo(`Uploaded HTML artifact: ${HTML_ARTIFACT_NAME}`);
          return true;
        }),
      ),

    downloadAllDiffResults: (
      token: string,
      runId: number,
      owner: string,
      repo: string,
    ): Effect.Effect<readonly DiffResult[], ArtifactError> => {
      const downloadPath = nodePath.join(os.tmpdir(), "dix-results");
      const findBy: FindBy = {
        token,
        workflowRunId: runId,
        repositoryOwner: owner,
        repositoryName: repo,
      };

      return Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => fs.mkdir(downloadPath, { recursive: true }),
          catch: (e) =>
            new ArtifactError({
              name: "download",
              message: `Failed to create download directory: ${e}`,
            }),
        });

        const artifacts = yield* Effect.tryPromise({
          try: () => artifactClient.listArtifacts({ findBy }),
          catch: (e) =>
            new ArtifactError({
              name: "list",
              message: `Failed to list artifacts: ${e}`,
            }),
        });

        const diffArtifacts = artifacts.artifacts.filter((a) => a.name.startsWith("diff-result-"));

        // Each artifact archive contains a file named "result.json"; extracting
        // them concurrently into a shared directory makes the legs clobber each
        // other (#51). Give every artifact its own subdirectory keyed by its
        // unique id so parallel downloads stay isolated.
        const nestedResults = yield* Effect.forEach(
          diffArtifacts,
          (art) =>
            downloadAndParseArtifact(art, nodePath.join(downloadPath, String(art.id)), findBy),
          { concurrency: "unbounded" },
        );

        return nestedResults.flat();
      });
    },
  },
}) {}
