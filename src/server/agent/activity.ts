// How Rune Browser's own tool calls show in the chat. Tools that do something
// worth a sentence log it themselves (ToolEnv.log, "Customized example.com");
// every other call gets a line from here, so no tool call goes unseen.
import type { ToolActivity, ToolKind } from "../../shared/api";
import { argsDetail } from "../providers/Provider";

type Args = Record<string, unknown>;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
/** ` “value”` when there is one. */
const quoted = (v: unknown, max = 50) => (str(v) ? ` “${clip(str(v)!, max)}”` : "");
/** ` value` when there is one (paths, selectors). */
const plain = (v: unknown, max = 60) => (str(v) ? ` ${clip(str(v)!, max)}` : "");

const tools: Record<string, { kind: ToolKind; title: (args: Args) => string }> = {
  // The page (the website, or the app's preview).
  get_page: { kind: "page", title: () => "Read the page" },
  navigate: { kind: "web", title: (a) => `Opened${plain(a.url, 70) || " a page"}` },
  reload: { kind: "page", title: () => "Reloaded the page" },
  wait_for: { kind: "page", title: (a) => `Waited for${plain(a.selector ?? a.text) || " the page"}` },
  screenshot: {
    kind: "screenshot",
    title: (a) =>
      `Took a screenshot${str(a.selector) ? ` of ${clip(str(a.selector)!, 50)}` : ""}${str(a.save_as) ? " and saved it" : ""}`,
  },
  inspect: { kind: "inspect", title: (a) => `Inspected${plain(a.selector) || " the page"}` },
  element_styles: { kind: "inspect", title: (a) => `Looked at the styles of${plain(a.selector) || " an element"}` },
  accessibility_tree: { kind: "inspect", title: () => "Read the accessibility tree" },
  run_js: { kind: "code", title: () => "Ran JavaScript on the page" },
  console_logs: { kind: "inspect", title: () => "Read the console" },
  page_storage: { kind: "inspect", title: () => "Looked at the page's storage" },
  page_metrics: { kind: "performance", title: () => "Measured the page" },
  performance_trace: { kind: "performance", title: () => "Recorded a performance trace" },
  code_coverage: { kind: "performance", title: () => "Measured code coverage" },
  emulate: { kind: "page", title: () => "Changed the emulated device" },
  scroll: { kind: "browse", title: () => "Scrolled the page" },
  press_key: { kind: "browse", title: (a) => `Pressed${plain(a.key, 30) || " a key"}` },
  click: { kind: "browse", title: (a) => `Clicked${plain(a.selector ?? a.text) || " on the page"}` },
  type_text: { kind: "browse", title: () => "Typed on the page" },
  fill_form: { kind: "browse", title: () => "Filled in a form" },
  confirm_action: { kind: "browse", title: () => "Asked to confirm an action" },
  upload_file: { kind: "browse", title: () => "Uploaded files to the page" },
  // The chat's folder.
  list_files: { kind: "read", title: (a) => `Listed the chat's files${plain(a.path) ? ` in${plain(a.path)}` : ""}` },
  read_file: { kind: "read", title: (a) => `Read${plain(a.path) || " a file"}` },
  write_file: { kind: "create", title: (a) => `Wrote${plain(a.path) || " a file"}` },
  edit_file: { kind: "edit", title: (a) => `Edited${plain(a.path) || " a file"}` },
  delete_file: { kind: "edit", title: (a) => `Deleted${plain(a.path) || " a file"}` },
  show_files: { kind: "read", title: () => "Showed files" },
  copy_to_project: { kind: "create", title: (a) => `Copied${plain(a.path) || " a file"} into the project` },
  // Site customizations and page changes.
  get_site_override: { kind: "customize", title: () => "Read the site's customization" },
  set_site_override: { kind: "customize", title: () => "Customized the site" },
  list_page_changes: { kind: "customize", title: () => "Listed the page changes" },
  add_page_change: { kind: "customize", title: (a) => `Added a page change${quoted(a.title)}` },
  update_page_change: { kind: "customize", title: () => "Updated a page change" },
  remove_page_change: { kind: "customize", title: () => "Removed a page change" },
  // Network.
  network_requests: { kind: "network", title: () => "Looked at the network requests" },
  network_request: { kind: "network", title: () => "Looked at a network request" },
  replay_request: { kind: "network", title: () => "Replayed a request" },
  saved_requests: { kind: "network", title: () => "Listed the saved requests" },
  save_request: { kind: "network", title: (a) => `Saved a request${quoted(a.name)}` },
  send_saved_request: { kind: "network", title: () => "Sent a saved request" },
  response_overrides: { kind: "network", title: () => "Listed the response overrides" },
  override_response: { kind: "network", title: () => "Overrode a response" },
  remove_response_override: { kind: "network", title: () => "Removed a response override" },
  api_map: { kind: "network", title: () => "Read the API map" },
  // The app.
  create_project: { kind: "app", title: () => "Created the project" },
  app_status: { kind: "app", title: () => "Checked the app" },
  app_logs: { kind: "app", title: () => "Read the app's logs" },
  restart_app: { kind: "app", title: () => "Restarted the app" },
  set_app_info: { kind: "app", title: () => "Updated the app's name and icon" },
  app_data: { kind: "app", title: () => "Looked at the app's data" },
  run_command: {
    kind: "command",
    title: (a) => `Ran${str(a.command) ? ` \`${clip(str(a.command)!, 70)}\`` : " a command"}`,
  },
  search_icons: { kind: "search", title: (a) => `Searched icons for${quoted(a.query)}` },
  list_app_tools: { kind: "app", title: () => "Listed the apps' tools" },
  use_app_tool: { kind: "app", title: (a) => `Used${plain(a.tool, 40) || " an app's tool"}` },
  // Schedules, snapshots, secrets, tabs.
  list_schedules: { kind: "schedule", title: () => "Listed the schedules" },
  create_schedule: { kind: "schedule", title: (a) => `Scheduled${quoted(a.name) || " a task"}` },
  update_schedule: { kind: "schedule", title: () => "Updated a schedule" },
  delete_schedule: { kind: "schedule", title: () => "Deleted a schedule" },
  run_schedule: { kind: "schedule", title: () => "Ran a schedule" },
  list_snapshots: { kind: "snapshot", title: () => "Listed the snapshots" },
  view_snapshot: { kind: "snapshot", title: () => "Looked at a snapshot" },
  restore_snapshot: { kind: "snapshot", title: () => "Restored a snapshot" },
  list_secrets: { kind: "secret", title: () => "Listed the secrets" },
  request_secret: { kind: "secret", title: (a) => `Asked for the secret${plain(a.name, 40) || ""}` },
  list_tabs: { kind: "tab", title: () => "Listed the tabs" },
  read_tab: { kind: "tab", title: (a) => `Read the tab${quoted(a.tab, 40)}` },
  // Attached code.
  list_sources: { kind: "source", title: () => "Listed the attached code" },
  list_source_files: { kind: "source", title: (a) => `Listed files${plain(a.path) ? ` in${plain(a.path)}` : ""}` },
  read_source_file: { kind: "read", title: (a) => `Read${plain(a.path) || " a file"}` },
  search_source: { kind: "search", title: (a) => `Searched the code for${quoted(a.query ?? a.pattern)}` },
  source_git: { kind: "source", title: (a) => `Ran git${plain(a.command ?? a.args, 50)}` },
  pull_source: { kind: "source", title: () => "Pulled the attached code" },
  edit_source_file: { kind: "edit", title: (a) => `Edited${plain(a.path) || " a file"}` },
  write_source_file: { kind: "create", title: (a) => `Wrote${plain(a.path) || " a file"}` },
};

const humanize = (name: string) => {
  const words = name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The kind of a Rune Browser tool (for lines it logs itself). */
export const toolKind = (name: string): ToolKind => tools[name]?.kind ?? "other";

/** A line for a call of a Rune Browser tool that didn't log one itself. */
export function describeRuneTool(name: string, args: unknown): ToolActivity {
  const input = args && typeof args === "object" ? (args as Args) : {};
  const known = tools[name];
  const detail = argsDetail(input);
  return {
    kind: known?.kind ?? "other",
    title: known ? known.title(input) : humanize(name),
    ...(detail ? { detail } : {}),
  };
}
