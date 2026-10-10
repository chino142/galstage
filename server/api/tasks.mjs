/**
 * 任务中心接口：把三处后台活儿并在一起返回 ——
 *   tasks（备份 / 恢复 / 清理 / 导入这种一次性活儿）+ comfy（出图队列）+ 定时任务最近一次结果。
 * 取消 / 重试出图走原有的 /api/comfy/runs/:id/*，这里不重复造。
 */

export function register(router, { engine, runtime }) {
  const tasks = engine.services.tasks;

  router.get('/api/tasks', (ctx) =>
    ctx.json(200, {
      ...tasks.list(),
      // scheduler.list() 返回的是 { items, kinds, ... }，这里只要那串任务
      scheduled: runtime?.scheduler?.list?.()?.items ?? [],
    }),
  );

  /** 清掉已经结束的记录（在跑的留着）。 */
  router.post('/api/tasks/clear', (ctx) => ctx.json(200, tasks.clear()));
}
