/** 把所有接口模块挂到路由器上。新增接口模块只需在这里加一行。 */

import * as system from './system.mjs';
import * as characters from './characters.mjs';
import * as writing from './writing.mjs';
import * as playing from './playing.mjs';
import * as toolbox from './toolbox.mjs';
import * as platform from './platform.mjs';
import * as modelsApi from './models.mjs';
import * as agentApi from './agent.mjs';
import * as mcpApi from './mcp.mjs';
import * as creativeApi from './creative.mjs';
import * as pluginsApi from './plugins.mjs';
import * as stagingApi from './staging.mjs';
import * as studioApi from './studio.mjs';
import * as galgameApi from './galgame.mjs';
import * as plansApi from './plans.mjs';
import * as collectionsApi from './collections.mjs';

export const API_MODULES = [system, characters, writing, playing, platform, modelsApi, mcpApi, agentApi, creativeApi, pluginsApi, stagingApi, studioApi, toolbox, galgameApi, plansApi, collectionsApi];

export function registerApi(router, deps) {
  for (const mod of API_MODULES) mod.register(router, deps);
  return router;
}
