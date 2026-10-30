import { getClerkToken } from "../saas-clerk";
import { cloudApiBase, isCloudBuild } from "./cloud-env";

/** Resolve the first-party referral cookie to the signed-in SaaS user. */
export async function affiliateSyncAttribution(): Promise<void> {
  if (!isCloudBuild()) return;
  try {
    const params = new URLSearchParams(location.search);
    const ref = params.get("ref");
    if (ref) {
      await fetch(`${cloudApiBase()}/affiliate/track?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(location.pathname)}`, {
        method: "POST", credentials: "include", cache: "no-store",
      });
    }
    const token = await getClerkToken();
    if (!token) return;
    await fetch(`${cloudApiBase()}/affiliate/me`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
      cache: "no-store",
    });
  } catch (err) {
    // Attribution is non-blocking: sign-in and workspace boot must remain usable.
    console.warn("[affiliate] attribution sync unavailable", String(err));
  }
}
