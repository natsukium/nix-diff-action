# nix-diff-action

A GitHub Action to compare Nix derivations between base and PR branches using [dix](https://github.com/manic-systems/dix).

> [!WARNING]
> **Alpha Version** - This action is under active development. APIs and behavior may change without notice. We recommend pinning to a specific release version or commit SHA.

## Features

- Compare Nix derivations and post diff results as PR comments
- Support for multiple derivations
- Three operation modes for different use cases
- Compare derivation (.drv) or built output paths

## Requirements

- Nix with flakes enabled (requires a Nix installer action, e.g., [cachix/install-nix-action](https://github.com/cachix/install-nix-action))

> [!NOTE]
> This action now only supports Nix flakes. Traditional Nix expressions (`nix-build`) are not supported.

dix is built from the `nixpkgs` input of the base branch's flake, so its version follows your nixpkgs. dix 1.x, 2.x, and 3.x are supported. With dix 2.0 or later, the action reads dix's JSON report and renders package tables; dix 1.x has no JSON output, so its human-readable output is shown as is.

## Quick Start

```yaml
name: Nix Diff

on:
  pull_request:

jobs:
  nix-diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@main
      - uses: cachix/install-nix-action@main
      - uses: natsukium/nix-diff-action@main
        with:
          attributes: |
            - displayName: my-nixos
              attribute: nixosConfigurations.my-nixos.config.system.build.toplevel
            - displayName: my-macos
              attribute: darwinConfigurations.my-macos.system
```

## Modes

### Full Mode

For most users. Runs diffs sequentially and posts a single comment.

```yaml
- uses: natsukium/nix-diff-action@main
  with:
    attributes: |
      - displayName: host1
        attribute: nixosConfigurations.host1.config.system.build.toplevel
      - displayName: host2
        attribute: nixosConfigurations.host2.config.system.build.toplevel
```

### Diff-Only Mode

For parallel execution with matrix strategy. Runs diff and uploads results as artifacts. Typically used in combination with the following comment-only mode.

### Comment-Only Mode

Aggregates all diff results from artifacts and posts a single PR comment. Used together with diff-only mode.

Here's an example of combining both modes:

```yaml
jobs:
  diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    strategy:
      matrix:
        host: [host1, host2, host3]
    steps:
      - uses: actions/checkout@main
      - uses: cachix/install-nix-action@main
      - uses: natsukium/nix-diff-action@main
        with:
          mode: diff-only
          attributes: |
            - displayName: ${{ matrix.host }}
              attribute: nixosConfigurations.${{ matrix.host }}.config.system.build.toplevel

  comment:
    needs: diff
    runs-on: ubuntu-latest
    permissions:
      actions: read
      pull-requests: write
    steps:
      - uses: natsukium/nix-diff-action@main
        with:
          mode: comment-only
```

## Inputs

| Input              | Required | Default               | Description                                                                              |
| ------------------ | -------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `mode`             | No       | `full`                | Operation mode: `full`, `diff-only`, or `comment-only`                                   |
| `attributes`       | No\*     | -                     | Nix attributes in YAML format. Each item should have `displayName` and `attribute` keys. |
| `build`            | No       | `false`               | Build derivations before comparing (see details below)                                   |
| `directory`        | No       | `.`                   | Directory containing flake.nix                                                           |
| `github-token`     | No       | `${{ github.token }}` | GitHub token for posting comments                                                        |
| `skip-no-change`   | No       | `true`                | Skip posting comment when there are no differences                                       |
| `comment-strategy` | No       | `create`              | `create` to always create new comment, `update` to update existing comment               |

\* `attributes` is required for `full` and `diff-only` modes. Not required for `comment-only` mode (which reads from artifacts).

### Build Option Details

By default, nix-diff-action compares derivation files (.drv) without building. This is fast and suitable for most cases.

Set `build: true` to build derivations and compare output paths instead. This enables closure size comparison but significantly increases workflow execution time. The workflow must run on a platform matching the derivation (e.g., `x86_64-linux` derivations require Linux runners, `aarch64-darwin` derivations require macOS ARM runners).

## Outputs

| Output | Description                                    |
| ------ | ---------------------------------------------- |
| `diff` | JSON array of diff results, one per attribute. |

Each item of `diff` has these keys:

| Key             | Description                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `displayName`   | Display name of the attribute                                                                       |
| `attributePath` | Nix attribute path that was compared                                                                |
| `basePath`      | Store path on the base branch                                                                       |
| `prPath`        | Store path on the PR branch                                                                         |
| `hasChanges`    | Whether the two store paths differ                                                                  |
| `format`        | `json` with dix 2.0 or later, `text` with dix 1.x                                                   |
| `report`        | The report from `dix --output json`, present when `format` is `json`. Its schema is defined by dix. |
| `text`          | The human-readable dix output, present when `format` is `text`                                      |

## Example Output

The action posts a comment like this to your PR:

> ## Nix Diff
>
> [Compare changes](https://github.com/owner/repo/compare/abc1234...def5678)
>
> ### host1
>
> **Attribute**: `nixosConfigurations.host1.config.system.build.toplevel`
>
> |              |       Base |         PR |        Diff |
> | ------------ | ---------: | ---------: | ----------: |
> | Closure size | `29.7 GiB` | `29.7 GiB` | `-19.3 MiB` |
> | Store paths  |       4210 |       4206 |   +38 / −42 |
>
> <details>
> <summary>Changed (6)</summary>
>
> | Package                   | Version                                           |      Size |
> | ------------------------- | ------------------------------------------------- | --------: |
> | `7zz`                     | `24.09 → 25.00`                                   | +12.1 KiB |
> | `grim`                    | `1.4.1 → 1.5.0`                                   |  +1.4 KiB |
> | `hyprutils`               | `0.7.1 → 0.8.1`                                   |  +8.3 KiB |
> | `nixos-system-temperance` | `25.11.19800101.2a21304 → 25.11.19800101.be9e214` |           |
> | `thunderbird`             | `139.0.2 → 140.0`                                 |  +2.0 MiB |
> | `thunderbird-unwrapped`   | `139.0.2 → 140.0`                                 |  +2.1 MiB |
>
> </details>
>
> <details>
> <summary>Added (1)</summary>
>
> | Package                    | Version |      Size |
> | -------------------------- | ------- | --------: |
> | `hostname-hostname-debian` | `3.25`  | +98.6 KiB |
>
> </details>
>
> <details>
> <summary>Removed (5)</summary>
>
> | Package              | Version  |      Size |
> | -------------------- | -------- | --------: |
> | `hostname-net-tools` | `2.10`   | -88.0 KiB |
> | `net-tools`          | `2.10`   |  -1.1 MiB |
> | `onefetch`           | `2.24.0` | -14.6 MiB |
> | `swww`               | `0.10.3` |  -3.2 MiB |
> | `unit-swww.service`  | `<none>` |  -1.0 KiB |
>
> </details>
>
> <sub>12 packages with only a minor size change hidden.</sub>

Like dix's own output, packages whose version did not change and whose size changed by less than 1 MiB are hidden from the comment. The full report is available in the `diff` output and the workflow artifacts.

Each package group is collapsed by default. Version lists longer than five entries per side are shortened with "+N more". If the comment would exceed GitHub's size limit, the space is shared between the groups and the remaining package rows (and, with many attributes, whole attributes) are omitted with a note pointing to the full results in the workflow artifacts.

## Permissions

Required permissions vary by mode:

| Mode           | `contents: read`   | `pull-requests: write` | `actions: read`        |
| -------------- | ------------------ | ---------------------- | ---------------------- |
| `full`         | ✓ (git operations) | ✓ (post comments)      | -                      |
| `diff-only`    | ✓ (git operations) | -                      | -                      |
| `comment-only` | -                  | ✓ (post comments)      | ✓ (download artifacts) |

## Fork Pull Requests

When using this action with pull requests from forks, the default `GITHUB_TOKEN` has limited permissions and cannot post comments to the PR. To enable commenting on fork PRs, use `pull_request_target` trigger.

> [!CAUTION]
> When using `pull_request_target`, the workflow runs in the context of the base branch with write permissions. Always use `actions/checkout` with `ref: ${{ github.event.pull_request.head.sha }}` to checkout the PR's code, and be cautious about running untrusted code from forks.

## License

GPL-3.0
