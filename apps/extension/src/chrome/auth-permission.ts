// The OpenApps origin is an *optional* host permission, so the browser's
// install dialog never says "Read and change your data on
// auth.opencapture.app". That sentence is the single most off-putting line in
// the install flow, and it was being shown to everyone to support a sign-in
// that most users never touch — this extension's whole posture is that
// capture itself needs no standing host access (see docs/architecture.md's
// trust-badge rationale), and the account layer was the one exception.
//
// The cost is that the origin has to be requested before any of it works, and
// the callback content script cannot be declared in the manifest — a
// declarative content_scripts entry produces the same install warning on its
// own, regardless of host_permissions. So it is registered at runtime instead,
// once the permission exists.
import { OPENAPPS_BASE_URL } from "./openapps-session";
import { ext } from "../platform/webext";

const AUTH_ORIGIN = `${OPENAPPS_BASE_URL}/*`;
const CALLBACK_SCRIPT_ID = "openapps-callback";

/** The pages that hand out a session or need one — the old manifest matches. */
const CALLBACK_MATCHES = [
  `${OPENAPPS_BASE_URL}/v1/auth/oidc/google/callback*`,
  `${OPENAPPS_BASE_URL}/signin*`,
  `${OPENAPPS_BASE_URL}/link*`,
];

export async function hasAuthAccess(): Promise<boolean> {
  try {
    return await ext.permissions.contains({ origins: [AUTH_ORIGIN] });
  } catch {
    return false;
  }
}

/**
 * Register the token-relay content script. Idempotent: re-registering a live
 * id throws, and this runs both on startup and on permissions.onAdded.
 *
 * Registration itself requires the host permission, so it can only run after a
 * grant — never at install.
 */
export async function registerCallbackScript(): Promise<void> {
  if (!(await hasAuthAccess())) return;
  try {
    const existing = await ext.scripting.getRegisteredContentScripts({ ids: [CALLBACK_SCRIPT_ID] });
    if (existing.length > 0) return;
  } catch {
    // getRegisteredContentScripts rejects rather than returning [] on some
    // builds when nothing is registered; fall through and let register decide.
  }
  try {
    await ext.scripting.registerContentScripts([
      {
        id: CALLBACK_SCRIPT_ID,
        matches: CALLBACK_MATCHES,
        js: ["openapps-callback.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  } catch (error) {
    // A duplicate id is the expected race between startup and onAdded, and
    // means the script is already live — anything else is worth surfacing.
    if (!String(error).includes("Duplicate script ID")) {
      console.warn("[openapps] could not register the callback script", error);
    }
  }
}

/**
 * Ask for the origin, then make sure the relay script is live before the
 * caller opens an auth tab.
 *
 * Call this before any other await in a click handler: permissions.request
 * needs the user gesture and the first await spends it.
 */
export async function ensureAuthAccess(): Promise<boolean> {
  let granted = false;
  try {
    // `request` must be the FIRST await here, and this the first await in the
    // click handler that calls it. Firefox discards the user gesture at the
    // first await and then resolves `request` to false having never shown a
    // prompt — which looks from the outside like a browser that silently
    // refused, and is what "I do not see it asking for permission" was.
    //
    // This used to check `contains` first, which is what spent the gesture.
    // There was nothing to gain by it: `request` resolves true without a
    // prompt when the origin is already granted.
    granted = await ext.permissions.request({ origins: [AUTH_ORIGIN] });
  } catch {
    granted = false;
  }
  if (!granted) return false;
  await registerCallbackScript();
  return true;
}
