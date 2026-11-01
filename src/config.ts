import * as core from "@actions/core";
import { Config, ConfigProvider, pipe } from "effect";

// Custom ConfigProvider for GitHub Actions
// Prioritizes environment variables with core.getInput() as fallback
const ActionsConfigProvider = pipe(
  ConfigProvider.fromEnv(),
  ConfigProvider.orElse(
    // core.getInput() returns "" for unset inputs; keep it as a value so string
    // inputs like `attributes` reach their own validation instead of failing as missing
    ConfigProvider.fromUnknown(
      {
        mode: core.getInput("mode"),
        "github-token": core.getInput("github-token"),
        attributes: core.getInput("attributes"),
        directory: core.getInput("directory"),
        build: core.getInput("build"),
        "skip-no-change": core.getInput("skip-no-change"),
        "comment-strategy": core.getInput("comment-strategy"),
      },
      { preserveEmptyStrings: true },
    ),
  ),
);

export const ActionConfig = {
  mode: Config.Literals(["full", "diff-only", "comment-only"], "mode"),
  githubToken: Config.Redacted("github-token"),
  attributes: Config.String("attributes"),
  directory: Config.String("directory"),
  build: Config.Boolean("build"),
  skipNoChange: Config.Boolean("skip-no-change"),
  commentStrategy: Config.Literals(["create", "update"], "comment-strategy"),
  githubRunId: Config.option(Config.String("GITHUB_RUN_ID")),
};

export const ConfigProviderLayer = ConfigProvider.layer(ActionsConfigProvider);
