// Full access (Settings → Agent): agents don't ask before what they'd
// otherwise need the user's OK for. Turning it on shows what that means first.
import { confirmDialog } from "../components/ConfirmDialog";
import { settings, updateSettings } from "./settings";

export const fullAccess = () => settings().agent.permissions === "full";

export const FULL_ACCESS_WARNING =
  "Agents then do everything without asking you first: customize and run scripts on sites, use sites with your logins (including buying, booking, sending, posting and deleting), send requests with your session, read your other tabs, use and change your other apps, and run things on a schedule. A web page can try to talk an agent into doing something you didn't ask for, and nothing stops it. Everything is still in Activity, and History can undo what it changed in your apps and customizations, but not what happened on websites.";

/** Switches the mode; turning full access on asks first. Returns whether it changed. */
export async function setFullAccess(on: boolean) {
  if (on === fullAccess()) return false;
  if (
    on &&
    !(await confirmDialog(`Give agents full access? ${FULL_ACCESS_WARNING}`, {
      confirmLabel: "Give full access",
      danger: true,
    }))
  )
    return false;
  updateSettings((s) => ({ ...s, agent: { ...s.agent, permissions: on ? "full" : "ask" } }));
  return true;
}
