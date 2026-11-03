export type HostingPlatform = "github" | "forgejo";

type HostingEnvironment = Readonly<Record<string, string | undefined>>;

export const detectHostingPlatform = (
  environment: HostingEnvironment = process.env,
): HostingPlatform => {
  if (environment.FORGEJO_SERVER_URL) {
    return "forgejo";
  }

  try {
    const apiUrl = new URL(environment.GITHUB_API_URL ?? "https://api.github.com");
    return apiUrl.pathname.replace(/\/+$/, "").endsWith("/api/v1") ? "forgejo" : "github";
  } catch {
    return "github";
  }
};

export const buildRunUrl = (
  platform: HostingPlatform,
  repoUrl: string,
  runId: string | undefined,
  runNumber: string | undefined,
): string | undefined => {
  // Forgejo addresses run pages by the repository-scoped run index exposed as
  // GITHUB_RUN_NUMBER; its GITHUB_RUN_ID is a global database id that 404s there.
  const segment = platform === "forgejo" ? runNumber : runId;
  return segment ? `${repoUrl}/actions/runs/${segment}` : undefined;
};
