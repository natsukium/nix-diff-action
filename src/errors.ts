import { Schema } from "effect";

export class NotPullRequestContextError extends Schema.TaggedError<NotPullRequestContextError>()(
  "NotPullRequestContextError",
  { message: Schema.String },
) {}

export class MissingAttributesError extends Schema.TaggedError<MissingAttributesError>()(
  "MissingAttributesError",
  { message: Schema.String },
) {}

export class InvalidModeError extends Schema.TaggedError<InvalidModeError>()("InvalidModeError", {
  mode: Schema.String,
}) {}

export class InvalidCommentStrategyError extends Schema.TaggedError<InvalidCommentStrategyError>()(
  "InvalidCommentStrategyError",
  { value: Schema.String },
) {}

export class AttributeParseError extends Schema.TaggedError<AttributeParseError>()(
  "AttributeParseError",
  { message: Schema.String },
) {}

export class GitWorktreeError extends Schema.TaggedError<GitWorktreeError>()("GitWorktreeError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class NixPathInfoError extends Schema.TaggedError<NixPathInfoError>()("NixPathInfoError", {
  flakeRef: Schema.String,
  message: Schema.String,
}) {}

export class NixDixError extends Schema.TaggedError<NixDixError>()("NixDixError", {
  basePath: Schema.String,
  prPath: Schema.String,
  message: Schema.String,
}) {}

export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()("GitHubApiError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export class ArtifactError extends Schema.TaggedError<ArtifactError>()("ArtifactError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export class InvalidDirectoryError extends Schema.TaggedError<InvalidDirectoryError>()(
  "InvalidDirectoryError",
  { message: Schema.String },
) {}
