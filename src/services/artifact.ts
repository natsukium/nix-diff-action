import { DefaultArtifactClient } from "@actions/artifact";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as nodePath from "path";
import * as os from "os";
import { Effect, Option, Schema } from "effect";
import { ArtifactError } from "../errors.js";
import { DiffResult, DiffResultArray } from "../schemas.js";

const artifactClient = new DefaultArtifactClient();

type FindBy = {
  token: string;
  workflowRunId: number;
  repositoryOwner: string;
  repositoryName: string;
};

// Convert error to Option.None with warning log
const withWarningOption = <A, E>(
  effect: Effect.Effect<A, E>,
  context: string,
): Effect.Effect<Option.Option<A>, never> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchAll((error) =>
      Effect.logWarning(`${context}: ${String(error)}`).pipe(Effect.as(Option.none())),
    ),
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

export class ArtifactService extends Effect.Service<ArtifactService>()("ArtifactService", {
  succeed: {
    uploadDiffResults: (
      results: readonly DiffResult[],
      displayName: string,
    ): Effect.Effect<string, ArtifactError> => {
      const artifactName = createArtifactName(displayName);

      return Effect.gen(function* () {
        const tempDir = yield* Effect.tryPromise({
          try: () => fs.mkdtemp(nodePath.join(os.tmpdir(), "dix-")),
          catch: (e) =>
            new ArtifactError({
              name: artifactName,
              message: `Failed to create temp directory: ${e}`,
            }),
        });

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
        return artifactName;
      });
    },

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

        const nestedResults = yield* Effect.forEach(
          diffArtifacts,
          (art) => downloadAndParseArtifact(art, downloadPath, findBy),
          { concurrency: "unbounded" },
        );

        return nestedResults.flat();
      });
    },
  },
}) {}
