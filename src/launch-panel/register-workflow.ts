import { WorkflowStore } from "../workflows/store.js";
import { launchPanelStateDir } from "./store.js";

export const LAUNCH_PANEL_WORKFLOW_ID = "launch-test-persona-panel";

export function ensureLaunchPanelWorkflow(): void {
  const workflows = new WorkflowStore(launchPanelStateDir());
  if (workflows.get(LAUNCH_PANEL_WORKFLOW_ID)) return;
  workflows.create({
    id: LAUNCH_PANEL_WORKFLOW_ID,
    name: "Launch-test persona panel",
    description:
      "Run a screenshot-backed customer-avatar group room through real website signup, onboarding, product, lesson, mobile, pricing and checkout-handoff flows.",
    tags: ["launch", "conversion", "group-chat", "browser", "qa"],
    author: "launch-panel",
    timeoutSeconds: 21_600,
    inputs: [
      { name: "url", label: "Website URL", type: "url", required: true },
      { name: "personas", label: "Persona ids (optional)", type: "string", required: false },
      {
        name: "depth",
        label: "Depth",
        type: "select",
        required: true,
        default: "standard",
        options: [
          { value: "quick", label: "Quick" },
          { value: "standard", label: "Standard" },
          { value: "deep", label: "Deep" },
        ],
      },
    ],
    requires: [
      {
        kind: "tool",
        name: "launch_panel_run",
        reason: "Starts the persistent group-chat room and evidence workflow.",
      },
      { kind: "tool", name: "browser", reason: "Panelists must drive real clickable flows." },
    ],
    body: [
      "Run the `launch_panel_run` tool for `{{url}}` at `{{depth}}` depth.",
      "If `{{personas}}` is non-empty, split it on commas and pass those persona ids; otherwise use the enabled defaults.",
      "Keep the Launch Room observable. Do not claim completion until the run status is completed and both report paths exist.",
      "Never enter payment details or pay. Use marked test accounts only. Do not expose passwords from the protected credential file.",
    ].join("\n\n"),
  });
}
