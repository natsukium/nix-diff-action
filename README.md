# nix-diff-action

A GitHub Action to compare Nix derivations between base and PR branches using [dix](https://github.com/faukah/dix).

> ⚠️ **Alpha Version** - This action is under active development. APIs and behavior may change without notice. We recommend pinning to a specific release version or commit SHA.

## Features

- Compare Nix derivations and post diff results as PR comments
- Support for multiple derivations
- Three operation modes for different use cases
- Compare derivation (.drv) or built output paths

## Requirements

- Nix with flakes enabled (requires a Nix installer action, e.g., [cachix/install-nix-action](https://github.com/cachix/install-nix-action))

> **Note**: This action now only supports Nix flakes. Traditional Nix expressions (`nix-build`) are not supported.

## Quick Start

```yaml
name: Nix Diff

on:
  pull_request:

jobs:
  dix:
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

| Input              | Required | Default   | Description                                                                    |
| ------------------ | -------- | --------- | ------------------------------------------------------------------------------ |
| `mode`             | No       | `full`    | Operation mode: `full`, `diff-only`, or `comment-only`                         |
| `attributes`       | No\*     | -         | Nix attributes in YAML format. Each item should have `displayName` and `attribute` keys. |
| `build`            | No       | `false`   | Build derivations before comparing (see details below)                         |
| `directory`        | No       | `.`       | Directory containing flake.nix                                                 |
| `github-token`     | No       | `${{ github.token }}` | GitHub token for posting comments                                    |
| `skip-no-change`   | No       | `true`    | Skip posting comment when there are no differences                             |
| `comment-strategy` | No       | `create`  | `create` to always create new comment, `update` to update existing comment     |

\* `attributes` is required for `full` and `diff-only` modes. Not required for `comment-only` mode (which reads from artifacts).

### Build Option Details

By default, nix-diff-action compares derivation files (.drv) without building. This is fast and suitable for most cases.

Set `build: true` to build derivations and compare output paths instead. This enables closure size comparison but significantly increases workflow execution time. The workflow must run on a platform matching the derivation (e.g., `x86_64-linux` derivations require Linux runners, `aarch64-darwin` derivations require macOS ARM runners).

## Outputs

| Output | Description                      |
| ------ | -------------------------------- |
| `diff` | JSON array of diff results. Each item has `displayName` and `diff` keys. |

## Example Output

The action posts a comment like this to your PR:

> ## Nix Diff
>
> Changes: [Compare changes](https://github.com/owner/repo/compare/abc1234...def5678)
>
> ### host1
>
> **Attribute**: `nixosConfigurations.host1.config.system.build.toplevel`
>
> <details>
> <summary>Diff Output</summary>
>
> ```
> <<< /nix/var/nix/profiles/system-792-link
> >>> /nix/store/whdm0jm75sn6pn4397ss09zy7kxvm4pf-nixos-system-temperance-25.11.19800101.be9e214
>
> CHANGED
> [U.] 7zz                        24.09 → 25.00
> [U.] grim                       1.4.1 → 1.5.0
> [U.] hyprutils                  0.7.1 → 0.8.1
> [U.] nixos-system-temperance    25.11.19800101.2a21304 → 25.11.19800101.be9e214
> [U*] thunderbird                139.0.2 → 140.0
> [U.] thunderbird-unwrapped      139.0.2 → 140.0
>
> ADDED
> [A.] hostname-hostname-debian   3.25
>
> REMOVED
> [R.] hostname-net-tools         2.10
> [R.] net-tools                  2.10
> [R.] onefetch                   2.24.0
> [R-] swww                       0.10.3
> [R.] unit-swww.service          <none>
>
> SIZE: 29.7 GiB → 29.7 GiB
> DIFF: -19.3 MiB
> ```
>
> </details>

When there are no differences, the diff section shows "No differences found".

If the diff output exceeds 60KB, it will be automatically truncated with a link to the full results in the workflow artifacts.

## Permissions

Required permissions vary by mode:

| Mode           | `contents: read`       | `pull-requests: write` | `actions: read`            |
| -------------- | ---------------------- | ---------------------- | -------------------------- |
| `full`         | ✓ (git operations)     | ✓ (post comments)      | -                          |
| `diff-only`    | ✓ (git operations)     | -                      | -                          |
| `comment-only` | -                      | ✓ (post comments)      | ✓ (download artifacts)     |

## Fork Pull Requests

When using this action with pull requests from forks, the default `GITHUB_TOKEN` has limited permissions and cannot post comments to the PR. To enable commenting on fork PRs, use `pull_request_target` trigger.

**Security Note:** When using `pull_request_target`, the workflow runs in the context of the base branch with write permissions. Always use `actions/checkout` with `ref: ${{ github.event.pull_request.head.sha }}` to checkout the PR's code, and be cautious about running untrusted code from forks.

## License

GPL-3.0
