import { Schema } from "effect";

// Nix attribute path validation:
// - Must not start with '#' or '.#' (added internally when constructing reference)
// - Must be a valid Nix attribute path (identifiers separated by dots)
// - Nix identifiers: start with letter or underscore, followed by alphanumeric, underscore, hyphen, or apostrophe
const nixIdentifierPattern = "[a-zA-Z_][a-zA-Z0-9_'-]*";
const attributePathPattern = new RegExp(`^${nixIdentifierPattern}(\\.${nixIdentifierPattern})*$`);

const AttributePath = Schema.NonEmptyString.pipe(
  Schema.filter((s) => !s.startsWith("#") && !s.startsWith(".#"), {
    message: () =>
      "Attribute path must not start with '#' or '.#' - the reference prefix is added automatically",
  }),
  Schema.pattern(attributePathPattern, {
    message: () =>
      "Invalid attribute path format. Expected format: 'packages.x86_64-linux.default' or 'nixosConfigurations.myhost.config.system.build.toplevel'",
  }),
).annotations({
  identifier: "AttributePath",
  description: "Nix attribute path (e.g., packages.x86_64-linux.default)",
  examples: [
    "packages.x86_64-linux.default",
    "nixosConfigurations.myhost.config.system.build.toplevel",
    "devShells.x86_64-linux.default",
  ],
});

export const NixOutputConfig = Schema.Struct({
  displayName: Schema.NonEmptyString.annotations({
    description: "User-friendly name for this comparison",
  }),
  attribute: AttributePath.annotations({
    description: "Nix attribute path (e.g., packages.x86_64-linux.default)",
  }),
}).annotations({ identifier: "NixOutputConfig" });
export type NixOutputConfig = typeof NixOutputConfig.Type;

export const NixOutputConfigArray = Schema.Array(NixOutputConfig).annotations({
  identifier: "NixOutputConfigArray",
});

export const DiffResult = Schema.Struct({
  displayName: Schema.NonEmptyString.annotations({
    description: "User-friendly name from output config",
  }),
  attributePath: Schema.NonEmptyString.annotations({
    description: "Nix attribute path that was compared",
  }),
  baseRef: Schema.NonEmptyString.annotations({
    description: "Commit SHA of the base branch",
  }),
  prRef: Schema.NonEmptyString.annotations({
    description: "Commit SHA of the PR head",
  }),
  diff: Schema.NonEmptyString.annotations({
    description: "Diff output from dix tool",
  }),
}).annotations({ identifier: "DiffResult" });
export type DiffResult = typeof DiffResult.Type;

export const DiffResultArray = Schema.Array(DiffResult).annotations({
  identifier: "DiffResultArray",
});
