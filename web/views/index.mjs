/** 视图注册表：模块 id 或界面提示 → 视图工厂，没登记的走通用占位视图。 */

import { createCardsView } from './cards.mjs';
import { createCardEditorView } from './card-editor.mjs';
import { createSettingsView } from './settings.mjs';
import { createPlaceholderView } from './placeholder.mjs';
import { createWritingView } from './writing.mjs';
import { createAgentView } from './agent.mjs';
import { createMcpView } from './mcp.mjs';
import { createProvidersView } from './providers.mjs';
import { createChatView } from './chat.mjs';
import { createGroupView } from './group.mjs';
import { createStateView } from './state.mjs';
import { createNarrationView } from './narration.mjs';
import { createWorldbookView } from './worldbook.mjs';
import { createPromptsView } from './prompts.mjs';
import { createXrayView } from './xray.mjs';
import { createMemoryView } from './memory.mjs';
import { createVectorsView } from './vectors.mjs';
import { createComfyView } from './comfyui.mjs';
import { createCostView } from './cost.mjs';
import { createBackupView } from './backup.mjs';
import { createSchedulerView } from './scheduler.mjs';
import { createCardFrontendView } from './card-frontend.mjs';
import { createPerformanceView } from './performance.mjs';
import { createGalgameFrontendView } from './galgame-frontend.mjs';
import { createHostView } from './host.mjs';
import { createAssetsView } from './assets.mjs';
import { createStudioView } from './studio.mjs';

export const VIEW_FACTORIES = {
  cards: createCardsView,
  'cards:editor': createCardEditorView,
  settings: createSettingsView,
  writing: createWritingView,
  agent: createAgentView,
  mcp: createMcpView,
  providers: createProvidersView,
  model: createProvidersView,
  chat: createChatView,
  group: createGroupView,
  state: createStateView,
  narration: createNarrationView,
  worldbook: createWorldbookView,
  prompts: createPromptsView,
  xray: createXrayView,
  memory: createMemoryView,
  vectors: createVectorsView,
  comfyui: createComfyView,
  cost: createCostView,
  backup: createBackupView,
  scheduler: createSchedulerView,
  'card-frontend': createCardFrontendView,
  performance: createPerformanceView,
  'galgame-frontend': createGalgameFrontendView,
  host: createHostView,
  assets: createAssetsView,
  studio: createStudioView,
};

export function createView(module, ctx) {
  const key = module.web?.view;
  if (!key) return createPlaceholderView(module, ctx);
  const factory = VIEW_FACTORIES[`${key}:${ctx.viewKey ?? ''}`] ?? VIEW_FACTORIES[key];
  return factory ? factory(module, ctx) : createPlaceholderView(module, ctx);
}
