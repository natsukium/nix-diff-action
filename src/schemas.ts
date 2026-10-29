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

// Subset of the `dix diff --output json` report that the action renders.
// Unknown fields are ignored on decode so additive dix changes do not break
// us; a breaking change makes decoding fail and the caller falls back to the
// human-readable output instead.
const DixVersionAmount = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  amount: Schema.Number,
});

const DixVersionEvent = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("added"), version: DixVersionAmount }),
  Schema.Struct({ kind: Schema.Literal("removed"), version: DixVersionAmount }),
  Schema.Struct({
    kind: Schema.Literal("changed"),
    old: DixVersionAmount,
    new: DixVersionAmount,
  }),
  Schema.Struct({
    kind: Schema.Literal("amount_changed"),
    version: Schema.Struct({ name: Schema.NullOr(Schema.String) }),
    old_amount: Schema.Number,
    new_amount: Schema.Number,
  }),
);
export type DixVersionEvent = typeof DixVersionEvent.Type;

export const DixPackageDiff = Schema.Struct({
  name: Schema.String,
  versions: Schema.Array(DixVersionEvent),
  status: Schema.Literal("Changed", "Mixed", "Upgraded", "Downgraded", "Added", "Removed"),
  selection: Schema.String,
  has_omitted_versions: Schema.Boolean,
  size_old: Schema.Number,
  size_new: Schema.Number,
  size_delta: Schema.Number,
});
export type DixPackageDiff = typeof DixPackageDiff.Type;

export const DixReport = Schema.Struct({
  diffs: Schema.Array(DixPackageDiff),
  paths: Schema.Struct({
    old: Schema.Number,
    new: Schema.Number,
    added: Schema.Number,
    removed: Schema.Number,
  }),
  size_old: Schema.Number,
  size_new: Schema.Number,
}).annotations({ identifier: "DixReport" });
export type DixReport = typeof DixReport.Type;

export const DixOutput = Schema.Union(
  Schema.Struct({ format: Schema.Literal("json"), report: DixReport }),
  Schema.Struct({ format: Schema.Literal("text"), text: Schema.String }),
).annotations({ identifier: "DixOutput" });
export type DixOutput = typeof DixOutput.Type;

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
  basePath: Schema.NonEmptyString.annotations({
    description: "Nix store path of the base branch output",
  }),
  prPath: Schema.NonEmptyString.annotations({
    description: "Nix store path of the PR head output",
  }),
  diff: DixOutput.annotations({
    description: "Diff output from dix: the JSON report, or human-readable text for dix < 2.0",
  }),
}).annotations({ identifier: "DiffResult" });
export type DiffResult = typeof DiffResult.Type;

export const DiffResultArray = Schema.Array(DiffResult).annotations({
  identifier: "DiffResultArray",
});
