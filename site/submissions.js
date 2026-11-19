import { compareDebVersions } from "./debparse.js";

/** Superseded merged PRs are history, rather than deployments still waiting. */
export function pendingSubmissions(submissions, index) {
  return submissions.filter((sub) => {
    if (sub.state !== "open" && sub.state !== "merged") return false;
    const entries = index.get(sub.package) || [];
    if (entries.some((entry) => compareDebVersions(entry.Version, sub.version) === 0)) return false;
    if (sub.state === "merged" && entries.some((entry) => compareDebVersions(entry.Version, sub.version) > 0)) return false;
    return true;
  });
}
