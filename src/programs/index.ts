import * as nodePath from "node:path";
import { parse as parseYaml } from "yaml";
import { Effect, Schema } from "effect";
import { NixOutputConfig, NixOutputConfigArray } from "../schemas.js";
import {
  AttributeParseError,
  InvalidCommentStrategyError,
  InvalidDirectoryError,
  InvalidMaxCommentLengthError,
} from "../errors.js";
import type { CommentStrategy } from "../types.js";
import { defaultMaxCommentLength, type HostingPlatform } from "../services/hosting.js";

export { runFull } from "./full.js";
export { runDiff } from "./diff.js";
export { runComment } from "./comment.js";

export const parseAttributes = (
  input: string,
): Effect.Effect<readonly NixOutputConfig[], AttributeParseError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseYaml(input),
      catch: (e) =>
        new AttributeParseError({
          message: `YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    if (!Array.isArray(parsed)) {
      return yield* Effect.fail(
        new AttributeParseError({ message: "attributes must be a YAML array" }),
      );
    }

    return yield* Schema.decodeUnknownEffect(NixOutputConfigArray)(parsed).pipe(
      Effect.mapError(
        (e) =>
          new AttributeParseError({
            message: `Invalid attributes format: ${e.message}`,
          }),
      ),
    );
  });

const CommentStrategySchema = Schema.Literals(["create", "update"]);

export const parseCommentStrategy = (
  input: string,
): Effect.Effect<CommentStrategy, InvalidCommentStrategyError> =>
  Schema.decodeUnknownEffect(CommentStrategySchema)(input).pipe(
    Effect.mapError(() => new InvalidCommentStrategyError({ value: input })),
  );

export const validateDirectory = (
  directory: string,
  workspaceRoot: string,
): Effect.Effect<string, InvalidDirectoryError> => {
  const resolvedPath = nodePath.resolve(workspaceRoot, directory);
  const normalizedWorkspace = nodePath.resolve(workspaceRoot);

  // Ensure the resolved path is within the workspace
  // Use path separator to prevent prefix matching attacks (e.g., /workspace-evil matching /workspace)
  return resolvedPath.startsWith(normalizedWorkspace + nodePath.sep) ||
    resolvedPath === normalizedWorkspace
    ? Effect.succeed(resolvedPath)
    : Effect.fail(
        new InvalidDirectoryError({
          message: `directory must be within the workspace. Got: ${directory} (resolved to ${resolvedPath})`,
        }),
      );
};

export const parseMaxCommentLength = (
  input: string,
  platform: HostingPlatform,
): Effect.Effect<number, InvalidMaxCommentLengthError> => {
  const trimmed = input.trim();
  if (trimmed === "") return Effect.succeed(defaultMaxCommentLength(platform));
  const value = Number(trimmed);
  return /^[1-9]\d*$/.test(trimmed) && Number.isSafeInteger(value)
    ? Effect.succeed(value)
    : Effect.fail(new InvalidMaxCommentLengthError({ value: input }));
};
