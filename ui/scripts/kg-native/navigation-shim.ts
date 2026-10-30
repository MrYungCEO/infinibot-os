// Native bundle stand-in for ui/src/ui/navigation.ts (which pulls in the web
// shell: i18n, plugin host, icons). The graph model only builds web paths for
// "Open on web" targets; the app opens its own screens instead.
export type Tab = string;

export function pathForTab(tab: Tab, basePath = ""): string {
  return `${basePath}/${tab}`;
}

export function pathForEntity(opts: { kind: string; slug: string; tab?: Tab; basePath?: string }): string {
  return `${opts.basePath ?? ""}/${opts.kind}/${encodeURIComponent(opts.slug)}`;
}
