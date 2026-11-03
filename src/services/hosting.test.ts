import { describe, expect, test } from "vitest";
import { buildRunUrl, detectHostingPlatform } from "./hosting.js";

describe("detectHostingPlatform", () => {
  test("detects Forgejo from the native Forgejo environment", () => {
    expect(
      detectHostingPlatform({
        FORGEJO_SERVER_URL: "https://forge.example.com",
        GITHUB_API_URL: "https://forge.example.com/api/v1",
      }),
    ).toBe("forgejo");
  });

  test("detects Forgejo on runners that only expose GitHub-compatible variables", () => {
    expect(
      detectHostingPlatform({
        GITHUB_SERVER_URL: "https://forge.example.com",
        GITHUB_API_URL: "https://forge.example.com/api/v1",
      }),
    ).toBe("forgejo");
  });

  test("keeps GitHub Enterprise classified as GitHub", () => {
    expect(
      detectHostingPlatform({
        GITHUB_SERVER_URL: "https://github.example.com",
        GITHUB_API_URL: "https://github.example.com/api/v3",
      }),
    ).toBe("github");
  });
});

describe("buildRunUrl", () => {
  test("links a GitHub run by its global run id", () => {
    expect(buildRunUrl("github", "https://github.com/owner/repo", "12345", "7")).toBe(
      "https://github.com/owner/repo/actions/runs/12345",
    );
  });

  test("links a Forgejo run by its repository-scoped run number", () => {
    expect(buildRunUrl("forgejo", "https://forge.example.com/owner/repo", "12345", "7")).toBe(
      "https://forge.example.com/owner/repo/actions/runs/7",
    );
  });

  test("omits the link when Forgejo exposes no run number", () => {
    expect(
      buildRunUrl("forgejo", "https://forge.example.com/owner/repo", "12345", undefined),
    ).toBeUndefined();
  });
});
