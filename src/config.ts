import * as core from "@actions/core";
import { Config, ConfigProvider, Layer, pipe, Schema } from "effect";

// Custom ConfigProvider for GitHub Actions
// Prioritizes environment variables with core.getInput() as fallback
const ActionsConfigProvider = pipe(
  ConfigProvider.fromEnv(),
  ConfigProvider.orElse(() =>
    ConfigProvider.fromMap(
      new Map([
        ["mode", core.getInput("mode")],
        ["github-token", core.getInput("github-token")],
        ["attributes", core.getInput("attributes")],
        ["directory", core.getInput("directory")],
        ["build", core.getInput("build")],
        ["skip-no-change", core.getInput("skip-no-change")],
        ["comment-strategy", core.getInput("comment-strategy")],
      ]),
    ),
  ),
);

// Schema definitions for Config validation
const ModeSchema = Schema.Literal("full", "diff-only", "comment-only");
const CommentStrategySchema = Schema.Literal("create", "update");

export const ActionConfig = {
  mode: Schema.Config("mode", ModeSchema),
  githubToken: Config.redacted(Config.string("github-token")),
  attributes: Config.string("attributes"),
  directory: Config.string("directory"),
  build: Config.boolean("build"),
  skipNoChange: Config.boolean("skip-no-change"),
  commentStrategy: Schema.Config("comment-strategy", CommentStrategySchema),
  githubRunId: Config.option(Config.string("GITHUB_RUN_ID")),
};

export const ConfigProviderLayer = Layer.setConfigProvider(ActionsConfigProvider);
