/**
 * Content Studio seam — the single surface the `content-studio` plugin uses
 * to reach the content backend that still compiles into core. Re-exported by
 * `infinibot/plugin-sdk` as `contentStudio`. Handler modules, stores and
 * pollers load lazily, only after the plugin calls in.
 *
 * Docs: docs/plugins/CONTENT-STUDIO.md.
 */

import {
  CONTENT_STUDIO_PLUGIN_ID,
  contentStudioPluginMethod,
  listContentStudioMethods,
} from "./methods.js";
import {
  createContentStudioHandlers,
  handleContentStudioMedia,
  handleContentStudioVideo,
  isContentStudioActive,
  startContentStudioInstagramSync,
  startContentStudioPosting,
} from "./runtime.js";
import { CONTENT_STUDIO_TOOL_NAMES, createContentStudioTools } from "./tools.js";

export const contentStudio = {
  pluginId: CONTENT_STUDIO_PLUGIN_ID,
  pluginMethod: contentStudioPluginMethod,
  listMethods: listContentStudioMethods,
  createHandlers: createContentStudioHandlers,
  toolNames: CONTENT_STUDIO_TOOL_NAMES,
  createTools: createContentStudioTools,
  startInstagramSync: startContentStudioInstagramSync,
  startPosting: startContentStudioPosting,
  handleVideo: handleContentStudioVideo,
  handleMedia: handleContentStudioMedia,
  isActive: isContentStudioActive,
};

export type ContentStudioSeam = typeof contentStudio;
