/** 剧本合集接口：分组 / 分类 / 卡。业务在 engine.services.collections。 */

export function register(router, { engine }) {
  const collections = engine.services.collections;

  router.get('/api/collections', (ctx) => ctx.json(200, collections.list()));

  router.post('/api/collections', async (ctx) => ctx.json(201, collections.save((await ctx.body()) ?? {})));

  router.put('/api/collections/:id', async (ctx) =>
    ctx.json(200, collections.save({ ...((await ctx.body()) ?? {}), id: ctx.params.id })),
  );

  router.delete('/api/collections/:id', (ctx) => {
    collections.remove(ctx.params.id);
    return ctx.noContent();
  });

  router.get('/api/collections/:id/cards', (ctx) => ctx.json(200, collections.cards(ctx.params.id)));

  router.post('/api/collections/:id/cards', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(200, collections.addCards(ctx.params.id, body.characterIds ?? []));
  });

  // 前端那个 del() 不带 body，所以"移出"做成 POST，参数照旧走 body。
  router.post('/api/collections/:id/cards/remove', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    return ctx.json(200, collections.removeCards(ctx.params.id, body.characterIds ?? []));
  });
}
