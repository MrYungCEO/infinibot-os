import { render } from "lit";
import { describe, expect, it, vi } from "vitest";

import { createInitialApiKeysState, type ApiKeysState } from "../controllers/api-keys";
import { renderApiKeys, type ApiKeysProps } from "./api-keys";

function fixtureState(overrides: Partial<ApiKeysState> = {}): ApiKeysState {
  return {
    ...createInitialApiKeysState(),
    providers: [
      {
        provider: "openai",
        status: "static",
        profileCount: 1,
        profiles: [
          {
            profileId: "openai:work",
            provider: "openai",
            type: "api_key",
            status: "static",
            label: "work",
            email: "ops@example.com",
            maskedKey: "sk-proj-••••7A2C",
          },
        ],
      },
      {
        provider: "elevenlabs",
        status: "expired",
        profileCount: 1,
        profiles: [
          {
            profileId: "elevenlabs:default",
            provider: "elevenlabs",
            type: "api_key",
            status: "expired",
            label: "default",
            maskedKey: "xi-••••91B",
          },
        ],
      },
    ],
    profileCount: 2,
    ...overrides,
  };
}

function fixtureProps(state = fixtureState()): ApiKeysProps {
  return {
    state,
    onRefresh: vi.fn(),
    onFilterChange: vi.fn(),
    onShowAddDialog: vi.fn(),
    onHideAddDialog: vi.fn(),
    onFormChange: vi.fn(),
    onSaveKey: vi.fn(),
    onDeleteKey: vi.fn(),
    onTestKey: vi.fn(),
    onSelectProfile: vi.fn(),
  };
}

function mount(props: ApiKeysProps): HTMLDivElement {
  const container = document.createElement("div");
  render(renderApiKeys(props), container);
  return container;
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((item) =>
    item.textContent?.replace(/\s+/g, " ").trim().includes(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

describe("API Keys luxury vault", () => {
  it("groups configured providers and renders honest status metadata", () => {
    const container = mount(fixtureProps());

    expect(container.querySelector('[data-provider="openai"]')).not.toBeNull();
    expect(container.querySelector('[data-provider="elevenlabs"]')).not.toBeNull();
    expect(container.textContent).toContain("LLM");
    expect(container.textContent).toContain("Voice");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Invalid");
    expect(container.textContent).toContain("Provider-managed");
    expect(container.querySelector(".ak-hero__actions svg path")?.namespaceURI).toBe(
      "http://www.w3.org/2000/svg",
    );
  });

  it("keeps masked secrets masked until the safe fingerprint reveal is used", () => {
    const container = mount(fixtureProps());
    const secret = container.querySelector('[data-profile-id="openai:work"] .ak-secret code');
    const reveal = container.querySelector(
      '[aria-label="Reveal masked credential"]',
    ) as HTMLButtonElement;

    expect(secret?.textContent).toBe("••••••••••••••••");
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    reveal.click();
    expect(secret?.textContent).toBe("sk-proj-••••7A2C");
    expect(reveal.getAttribute("aria-label")).toBe("Hide masked credential");
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
  });

  it("reuses the existing upsert form for key replacement", () => {
    const props = fixtureProps();
    const container = mount(props);

    button(container.querySelector('[data-profile-id="openai:work"]')!, "Replace").click();

    expect(props.onSelectProfile).toHaveBeenCalledWith("openai:work");
    expect(props.onFormChange).toHaveBeenCalledWith("provider", "openai");
    expect(props.onFormChange).toHaveBeenCalledWith("profileName", "work");
    expect(props.onFormChange).toHaveBeenCalledWith("key", "");
    expect(props.onFormChange).toHaveBeenCalledWith("email", "ops@example.com");
    expect(props.onShowAddDialog).toHaveBeenCalledOnce();
  });

  it("preserves search, test, and add action contracts", () => {
    const props = fixtureProps();
    const container = mount(props);
    const search = container.querySelector('[data-learn-id="apikeys-search"]') as HTMLInputElement;

    search.value = "open";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    button(container.querySelector('[data-profile-id="openai:work"]')!, "Test").click();
    button(container, "Add credential").click();

    expect(props.onFilterChange).toHaveBeenCalledWith("open");
    expect(props.onTestKey).toHaveBeenCalledWith("openai:work");
    expect(props.onSelectProfile).toHaveBeenCalledWith(null);
    expect(props.onShowAddDialog).toHaveBeenCalledOnce();
  });

  it("disables save until a key is supplied in the add flow", () => {
    const state = fixtureState({
      showAddDialog: true,
      selectedProfileId: null,
      addForm: { provider: "anthropic", profileName: "default", key: "", email: "" },
    });
    const container = mount(fixtureProps(state));
    const save = container.querySelector(
      '[data-ib-target="control:apikeys/dialog/save"]',
    ) as HTMLButtonElement;

    expect(container.textContent).toContain("Connect Anthropic");
    expect(save.disabled).toBe(true);
    expect(container.textContent).toContain("never returned to this page");
  });

  it("announces provider choices and secret guidance to assistive technology", () => {
    const pickerState = fixtureState({
      showAddDialog: true,
      selectedProfileId: null,
      addForm: { provider: "", profileName: "default", key: "", email: "" },
    });
    const picker = mount(fixtureProps(pickerState));
    const providerGroup = picker.querySelector('[role="radiogroup"]');

    expect(providerGroup?.getAttribute("aria-labelledby")).toBe("ak-provider-picker-label");
    expect(providerGroup?.querySelectorAll('[role="radio"][aria-checked="false"]').length).toBeGreaterThan(1);

    const secretState = fixtureState({
      showAddDialog: true,
      selectedProfileId: null,
      addForm: { provider: "anthropic", profileName: "default", key: "", email: "" },
    });
    const secretForm = mount(fixtureProps(secretState));
    const dialog = secretForm.querySelector('[role="dialog"]');
    const secret = secretForm.querySelector("#ak-secret-key");

    expect(dialog?.getAttribute("aria-busy")).toBe("false");
    expect(secret?.getAttribute("aria-describedby")).toBe("ak-secret-help");
    expect(secretForm.querySelector("#ak-secret-help")?.textContent).toContain("never returned");
  });
});
