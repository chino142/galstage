/**
 * 花费与统计页：按对话 / 角色 / 天看 token 与金额，能填各家单价。
 *
 * "预估 vs 实际"是这一页的重点：预估是我们自己估算的 token，实际是提供方
 * 回来的 usage。差得多就说明估算需要调，或者有上下文没算进去。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState, table, kv } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

function money(value, currency = 'CNY') {
  const amount = Number(value ?? 0);
  if (!amount) return '0';
  return `${amount.toFixed(4)} ${currency}`;
}

function tokens(value) {
  const amount = Number(value ?? 0);
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`;
  return String(amount);
}

function percentText(delta) {
  if (!delta || delta.percent === null || delta.percent === undefined) return '—';
  const sign = delta.percent > 0 ? '+' : '';
  return `${sign}${delta.percent}%`;
}

export function createCostView(module) {
  const el = h('div', { class: 'view' });
  const summaryHost = h('div', {});
  const breakdownHost = h('div', {});
  const pricingHost = h('div', {});
  const recentHost = h('div', {});

  const form = {
    provider: h('select', {}),
    model: h('input', { type: 'text', placeholder: '留空 = 这家所有模型' }),
    priceIn: h('input', { type: 'text', placeholder: '输入：元 / 百万 token' }),
    priceOut: h('input', { type: 'text', placeholder: '输出：元 / 百万 token' }),
    discount: h('input', { type: 'text', placeholder: '缓存折扣，默认 0.1' }),
  };

  el.append(
    panel(module.title, null, h('span', { class: 'panel-note' }, module.summary)),
    summaryHost,
    breakdownHost,
    pricingHost,
    recentHost,
  );

  function renderSummary(summary) {
    const total = summary.totals ?? {};
    summaryHost.replaceChildren(
      panel(
        '总览',
        `近 ${summary.byDay?.length ?? 14} 天`,
        kv([
          ['轮数', `${total.turns ?? 0} 轮（其中 ${total.reportedTurns ?? 0} 轮是提供方上报的真实用量）`],
          ['输入 token', tokens(total.promptTokens)],
          ['输出 token', tokens(total.completionTokens)],
          ['合计花费', money(total.cost, summary.pricing?.[0]?.currency ?? 'CNY')],
          ['缓存节省', total.cachedTokens ? `${money(total.cacheSavings)}（命中 ${tokens(total.cachedTokens)} token）` : '提供方未上报缓存命中'],
          ['未配单价', `${total.unpricedTurns ?? 0} 轮`],
          ['预估 vs 实际（输入）', `${tokens(total.prompt?.estimated)} vs ${tokens(total.prompt?.actual)}（${percentText(total.prompt)}）`],
          ['预估 vs 实际（输出）', `${tokens(total.completion?.estimated)} vs ${tokens(total.completion?.actual)}（${percentText(total.completion)}）`],
        ]),
      ),
    );
  }

  function renderBreakdown(summary) {
    const byDay = [...(summary.byDay ?? [])].reverse().slice(-14);
    breakdownHost.replaceChildren(
      panel(
        '按天',
        `${byDay.length} 天`,
        byDay.some((row) => row.turns)
          ? table(
              ['日期', '轮数', 'token', '花费'],
              byDay.map((row) => [row.day, row.turns, tokens(row.totalTokens), money(row.cost)]),
            )
          : emptyState({ icon: '📅', title: '还没有用量' }),
      ),
      panel(
        '按模型',
        `${(summary.byModel ?? []).length} 个`,
        (summary.byModel ?? []).length
          ? table(
              ['模型', '轮数', 'token', '花费', '预估偏差'],
              summary.byModel.map((row) => [row.model ?? '（未记录）', row.turns, tokens(row.totalTokens), money(row.cost), percentText(row.prompt)]),
            )
          : emptyState({ icon: '🧮', title: '还没有用量' }),
      ),
    );
  }

  function renderChats(chats, characters) {
    const chatTable = (chats ?? []).length
      ? table(
          ['对话', '轮数', 'token', '花费'],
          chats.map((row) => [String(row.chatId ?? '（未归属）').slice(0, 12), row.turns, tokens(row.totalTokens), money(row.cost)]),
        )
      : emptyState({ icon: '💬', title: '还没有按对话的用量' });
    const charTable = (characters ?? []).length
      ? table(
          ['角色', '轮数', 'token', '花费'],
          characters.map((row) => [String(row.characterId ?? '（未归属）').slice(0, 12), row.turns, tokens(row.totalTokens), money(row.cost)]),
        )
      : emptyState({ icon: '🎭', title: '还没有按角色的用量' });
    breakdownHost.append(panel('按对话', `${(chats ?? []).length} 个`, chatTable), panel('按角色', `${(characters ?? []).length} 个`, charTable));
  }

  function renderPricing(payload, providers) {
    const options = [{ id: '', label: '（不限，所有提供方）' }, ...(providers ?? []).map((item) => ({ id: item.id, label: `${item.label}（${item.kind}）` }))];
    form.provider.replaceChildren(...options.map((item) => h('option', { value: item.id }, item.label)));

    const rows = payload.items ?? [];
    // 「+ 模型名」用你自己配的提供方 / 绑定（服务端现取），没配才回退到示例价目。
    // 写死的表过一阵全是老型号，所以这里优先动态那份。
    const suggestions = payload.suggestions ?? [];
    const quick = suggestions.length
      ? suggestions.slice(0, 8).map((item) => ({
          label: item.label,
          providerId: item.providerId,
          model: item.model,
          priceIn: item.hasPrice ? item.priceIn : null,
          priceOut: item.hasPrice ? item.priceOut : null,
          hint: item.providerLabel,
        }))
      : (payload.presets ?? []).slice(0, 6).map((preset) => ({
          label: preset.label,
          providerId: '',
          model: preset.model,
          priceIn: preset.priceIn,
          priceOut: preset.priceOut,
          hint: '示例',
        }));
    pricingHost.replaceChildren(
      panel(
        '各家单价',
        `${rows.length} 条`,
        h('div', { class: 'panel-note' }, '单位是「元 / 百万 token」。配了就覆盖提供方自带的 priceIn / priceOut；旧的花费不会重算。'),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginTop: '10px' } },
          field('提供方', form.provider),
          field('模型', form.model, '留空表示这家所有模型的默认价'),
          field('输入单价', form.priceIn),
          field('输出单价', form.priceOut),
          field('缓存折扣', form.discount, '0.1 表示缓存只收一折'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
          h('button', { class: 'btn primary', onclick: savePrice }, '保存单价'),
          ...quick.map((item) =>
            h(
              'button',
              {
                class: 'btn',
                title: item.priceIn !== null && item.priceOut !== null
                  ? `${item.hint} · 输入 ${item.priceIn} / 输出 ${item.priceOut} 元每百万`
                  : `${item.hint} · 这家的价格没存过，点完照你的账单填`,
                onclick: async () => {
                  form.provider.value = item.providerId;
                  form.model.value = item.model;
                  const known = item.priceIn !== null && item.priceOut !== null;
                  if (known) {
                    form.priceIn.value = String(item.priceIn);
                    form.priceOut.value = String(item.priceOut);
                  } else {
                    form.priceIn.value = '';
                    form.priceOut.value = '';
                  }
                  try {
                    if (!known) {
                      // 价格不知道就不瞎填：把模型放进表单，光标停在单价上，等你自己按账单填
                      toast(`已填好 ${item.label}：价格照你的账单选填，填完点「保存单价」`, { tone: 'warn', duration: 4200 });
                      form.priceIn.focus?.();
                      return;
                    }
                    await post('/api/cost/pricing', { providerId: item.providerId, model: item.model, label: item.label, priceIn: item.priceIn, priceOut: item.priceOut });
                    toast(`已加入 ${item.label}`);
                    await refreshPricing();
                  } catch (err) {
                    toastError(err);
                  }
                },
              },
              `+ ${item.label}`,
            ),
          ),
        ),
        h(
          'div',
          { class: 'hint', style: { marginTop: '6px' } },
          suggestions.length
            ? '上面这排是你在「模型接入」里配的提供方与模型（那边改了，这里跟着变）；价格写在这些提供方的 priceIn / priceOut 里就能一键带上。'
            : '一个提供方都还没配：先去「平台 → 模型接入」加一个，这排按钮就会换成你在用的模型。',
        ),
        rows.length
          ? table(
              ['提供方', '模型', '输入', '输出', '缓存折扣', ''],
              rows.map((row) => [
                row.providerId || '（任意）',
                row.model || '（全部）',
                row.priceIn ?? '—',
                row.priceOut ?? '—',
                row.cacheDiscount,
                h('button', { class: 'btn', onclick: () => removePrice(row) }, '删除'),
              ]),
            )
          : emptyState({ icon: '🏷️', title: '还没填单价', desc: '不填也能统计 token，只是没有金额。' }),
      ),
    );
  }

  async function savePrice() {
    try {
      await put('/api/cost/pricing', {
        providerId: form.provider.value,
        model: form.model.value.trim(),
        priceIn: form.priceIn.value === '' ? null : Number(form.priceIn.value),
        priceOut: form.priceOut.value === '' ? null : Number(form.priceOut.value),
        ...(form.discount.value === '' ? {} : { cacheDiscount: Number(form.discount.value) }),
      });
      toast('单价已保存');
      await refreshPricing();
    } catch (err) {
      toastError(err);
    }
  }

  async function removePrice(row) {
    try {
      await del(`/api/cost/pricing/${row.id}`);
      toast('已删除');
      await refreshPricing();
    } catch (err) {
      toastError(err);
    }
  }

  function renderRecent(items) {
    recentHost.replaceChildren(
      panel(
        '最近几轮',
        `${items.length} 条`,
        items.length
          ? table(
              ['时间', '模型', '输入', '输出', '花费', '来源'],
              items.map((row) => [
                String(row.createdAt ?? '').slice(5, 16).replace('T', ' '),
                row.model ?? '—',
                row.promptTokens,
                row.completionTokens,
                row.cost === null ? '未配单价' : money(row.cost),
                row.reported ? '提供方上报' : '估算',
              ]),
            )
          : emptyState({ icon: '🧾', title: '还没有记账' }),
      ),
    );
  }

  async function refreshSummary() {
    const [summary, chats, characters] = await Promise.all([
      get('/api/cost/summary'),
      get('/api/cost/by-chat'),
      get('/api/cost/by-character'),
    ]);
    renderSummary(summary);
    renderBreakdown(summary);
    renderChats(chats.items, characters.items);
  }

  async function refreshPricing() {
    const [payload, providers] = await Promise.all([get('/api/cost/pricing'), get('/api/providers')]);
    renderPricing(payload, providers.items);
  }

  async function refreshRecent() {
    const data = await get('/api/cost/usage?limit=30');
    renderRecent(data.items ?? []);
  }

  async function mount() {
    summaryHost.append(loading());
    breakdownHost.append(loading());
    pricingHost.append(loading());
    recentHost.append(loading());
    try {
      await refreshSummary();
    } catch (err) {
      summaryHost.replaceChildren(panel('总览', null, errorBox(err, { onRetry: mount })));
      breakdownHost.replaceChildren();
    }
    try {
      await refreshPricing();
    } catch (err) {
      pricingHost.replaceChildren(panel('各家单价', null, errorBox(err, { onRetry: refreshPricing })));
    }
    try {
      await refreshRecent();
    } catch (err) {
      recentHost.replaceChildren(panel('最近几轮', null, errorBox(err, { onRetry: refreshRecent })));
    }
  }

  return { el, mount };
}
