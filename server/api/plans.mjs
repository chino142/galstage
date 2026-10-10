/**
 * 坑本接口：想开的坑先记着，一键"开演"变成角色卡。
 * 业务都在 engine.services.plans 里，这里只做"收参数 → 调服务 → 出响应"。
 */

export function register(router, { engine }) {
  const plans = engine.services.plans;

  router.get('/api/plans', (ctx) => ctx.json(200, plans.list({ status: ctx.query.status ?? '' })));

  router.post('/api/plans', async (ctx) => ctx.json(201, plans.save((await ctx.body()) ?? {})));

  router.get('/api/plans/:id', (ctx) => {
    const found = plans.get(ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个坑：${ctx.params.id}`);
    return ctx.json(200, found);
  });

  router.put('/api/plans/:id', async (ctx) =>
    ctx.json(200, plans.save({ ...((await ctx.body()) ?? {}), id: ctx.params.id })),
  );

  router.delete('/api/plans/:id', (ctx) => {
    plans.remove(ctx.params.id);
    return ctx.noContent();
  });

  /** 开演：按坑本里的设定建一张角色卡。 */
  router.post('/api/plans/:id/promote', async (ctx) => ctx.json(201, { card: await plans.promote(ctx.params.id) }));
}
