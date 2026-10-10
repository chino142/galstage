/**
 * 任务中心：把"后台在跑的活儿"收进一个地方看。
 *
 * 数据来自三处，这里只负责把前两处拼起来（第三处是定时任务，接口层再并）：
 *   1) tasks 表：备份 / 恢复 / 清理 / 批量导入这种"点一下跑一次"的活儿
 *   2) comfy_runs：出图队列（本身就有状态和进度，不重复记）
 *
 * `run()` 是给调用方用的包装：跑之前记 start，跑完记 done/error；出错照旧抛出去，
 * 不改变原来的行为 —— 只是顺手留个记录。
 */

import { ProviderError } from '../errors.mjs';

export function createTasksService(ctx) {
  const store = () => ctx.ports.tasksStore ?? null;

  async function run({ kind = 'task', title = '后台任务', detail = null } = {}, work) {
    if (typeof work !== 'function') throw new ProviderError('tasks.run 需要传一个要跑的活');
    const found = store();
    if (!found) return work(); // 没接存储就当普通调用，别把活儿弄丢
    const task = found.start({ kind, title });
    try {
      const result = await work();
      found.finish(task.id, { status: 'done', detail: detail ?? summarize(result) });
      found.prune?.();
      return result;
    } catch (err) {
      found.finish(task.id, { status: 'error', error: err?.message ?? String(err) });
      found.prune?.();
      throw err;
    }
  }

  function list(query = {}) {
    const found = store();
    const tasks = found ? found.list({ limit: query.limit ?? 60 }) : [];
    const comfy = ctx.ports.comfyStore?.listRuns?.({ limit: query.comfyLimit ?? 20 }) ?? [];
    return {
      tasks,
      comfy,
      running: tasks.filter((task) => task.status === 'running').length,
      failed: tasks.filter((task) => task.status === 'error').length,
    };
  }

  function clear() {
    const found = store();
    if (!found) return { removed: 0 };
    return { removed: found.clearFinished() };
  }

  return { run, list, clear };
}

/** 结果摘要：给不同活儿一个能看懂的短句。 */
function summarize(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'string') return result.slice(0, 200);
  if (typeof result !== 'object') return String(result);
  if (result.name) return `备份 ${result.name}`;
  if (typeof result.imported === 'number') return `导入 ${result.imported} 张${result.skipped ? `，跳过 ${result.skipped}` : ''}`;
  if (result.removed !== undefined) return Array.isArray(result.removed) ? `清理 ${result.removed.length} 项` : `清理 ${result.removed}`;
  if (result.bytesFreed !== undefined) return `腾出 ${result.bytesFreed} 字节`;
  return null;
}
