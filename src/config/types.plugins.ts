export type PluginEntryConfig = {
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Appearance overrides (see src/plugins/appearance.ts). Applied live. */
  appearance?: Record<string, unknown>;
  /** Contribution keys (`<kind>:<id>`) switched off / default-off ones switched on. Applied live. */
  contributions?: { disabled?: string[]; enabled?: string[] };
  /** Permission keys the owner revoked (dependent contributions turn off), and
   *  gated (default-off) permission keys the owner granted. Applied live. */
  permissions?: { revoked?: string[]; granted?: string[] };
  /** Apply registry updates for this plugin automatically (default off). */
  autoUpdate?: boolean;
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  memory?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

/** The version a package install replaced, kept for one-step rollback. */
export type PluginInstallPrevious = {
  version: string;
  sha256?: string;
  /** Folder the previous version was moved to (absent when it was the bundled copy). */
  path?: string;
  /** The previous version was the copy that ships with InfiniBot. */
  bundled?: boolean;
  installedAt?: string;
};

export type PluginInstallRecord = {
  /**
   * npm / archive / path: legacy installers. zip (uploaded or local package),
   * url and registry: InfiniBot Plugin Packages (src/plugins/packages).
   */
  source: "npm" | "archive" | "path" | "zip" | "url" | "registry";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  /** Package installs: where the zip came from. */
  sourceUrl?: string;
  /** Registry the package was installed from (its updates come from there). */
  registryUrl?: string;
  /** sha256 of the installed package zip. */
  sha256?: string;
  sizeBytes?: number;
  /** Permission keys the owner has seen for this plugin (re-prompt only on new ones). */
  reviewedPermissions?: string[];
  /** This install replaces a plugin that ships with InfiniBot. */
  overridesBundled?: boolean;
  previous?: PluginInstallPrevious;
};

export type PluginUpdatesConfig = {
  /** Periodic background update check (default on; never installs by itself). */
  check?: boolean;
  /** Hours between background checks (default 12, minimum 1). */
  intervalHours?: number;
};

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  /** Plugin id whose declared landing page is the start page (e.g. clinic mode). */
  landing?: string;
  entries?: Record<string, PluginEntryConfig>;
  installs?: Record<string, PluginInstallRecord>;
  /** Marketplace registry origin (default: the InfiniBot site; env INFINIBOT_PLUGIN_REGISTRY_URL wins). */
  registryUrl?: string;
  updates?: PluginUpdatesConfig;
};
