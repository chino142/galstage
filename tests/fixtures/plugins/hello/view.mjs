/**
 * 示例插件的界面（浏览器端 ESM，无构建）。
 *
 * 契约：default export 一个 (module, ctx) => ({ el, mount? })。
 * ctx.ui 里有主前端的零件（h / panel / field…），但插件也可以像这里一样只用原生 DOM。
 */

export default function createHelloView(module) {
  const el = document.createElement('div');
  el.className = 'view';

  const box = document.createElement('div');
  box.className = 'panel';
  const head = document.createElement('div');
  head.className = 'panel-head';
  const title = document.createElement('h2');
  title.textContent = module?.title ?? 'Hello 插件';
  head.append(title);

  const hint = document.createElement('div');
  hint.className = 'panel-note hello-plugin-hint';
  hint.textContent = '这个页面来自插件目录里的 view.mjs，没有经过任何构建。';

  const out = document.createElement('div');
  out.className = 'panel-note';
  out.textContent = '还没请求过。';

  const button = document.createElement('button');
  button.className = 'btn primary';
  button.textContent = '调一下插件接口';
  button.onclick = async () => {
    try {
      const response = await fetch('/api/hello');
      out.textContent = JSON.stringify(await response.json());
    } catch (err) {
      out.textContent = `失败：${err?.message ?? err}`;
    }
  };

  box.append(head, hint, button, out);
  el.append(box);
  return { el, mount() {} };
}
