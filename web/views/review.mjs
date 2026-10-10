/**
 * 月度与年度报告页。
 *
 * 数据全部来自 /api/review/report（口径见 core/toolbox/review.mjs）；界面只负责把它
 * 画好看：概览大数字、**带封面的角色卡网格**（复用卡库那套 `.card-grid`）、
 * 本月出图的图片墙、每天 / 时段 / 星期的柱状，以及本地拼好的「一句话总结」。
 *
 * 布局尽量用并列（`.grid-2`）和网格，别一路从上往下堆。
 */

import { h } from '../core/dom.mjs';
import { get } from '../core/api.mjs';
import { panel, loading, errorBox, emptyState, table, kv } from '../ui/components.mjs';
import { toastError } from '../ui/toast.mjs';
import { translateTag } from '../core/tag-i18n.mjs';

function tokens(value) {
  const amount = Number(value ?? 0);
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (Math.abs(amount) >= 1000) return `${(amount / 1000).toFixed(1)}k`;
  return String(Math.round(amount));
}

function money(value) {
  const amount = Number(value ?? 0);
  if (!amount) return '0';
  if (Math.abs(amount) < 0.01) return amount.toFixed(4);
  return amount.toFixed(2);
}

function words(value) {
  const amount = Number(value ?? 0);
  if (Math.abs(amount) >= 10000) return `${(amount / 10000).toFixed(1)} 万`;
  if (Math.abs(amount) >= 1000) return `${(amount / 1000).toFixed(1)} 千`;
  return String(Math.round(amount));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 封面地址：有头像走卡的头像接口，没有就看平台导入时存下的封面素材。
 * 两者都没有就返回 null，界面上给占位图。
 */
function coverSrc(row) {
  if (row?.avatarAssetId && row?.characterId) return `/api/characters/${encodeURIComponent(row.characterId)}/avatar`;
  if (row?.coverAssetId) return `/api/assets/${encodeURIComponent(row.coverAssetId)}/file`;
  return null;
}

/** 封面加载失败就换成占位图（Skerry 的卡也是 onError 退回 default.png 这套）。 */
function fallbackCover(img, className, icon, text) {
  const placeholder = h(
    'div',
    { class: `${className} placeholder` },
    h('div', { class: 'card-grid-ph-icon' }, icon),
    h('div', { class: 'card-grid-ph-text' }, text),
  );
  if (typeof img.replaceWith === 'function') img.replaceWith(placeholder);
  else img.style.display = 'none';
}

/** 小指标卡：图标 + 大数字 + 标签。 */
function metric(icon, value, label) {
  return h(
    'div',
    { class: 'review-metric' },
    h('span', { class: 'review-metric-icon' }, icon),
    h('div', { class: 'review-metric-body' }, h('div', { class: 'review-metric-value' }, value), h('div', { class: 'review-metric-label' }, label)),
  );
}

/**
 * 「本月最爱」：带封面的一张卡 + 占比进度条。
 * 这是照 Skerry 年报的 featured 卡（cover + 名字 + 数值 + 进度）和 PotatoVN 年度报告的
 * 「年度最爱」（大封面 + 名字 + 时长）做的 —— 两家都拿一张主视觉把"最爱是谁"顶在最前面。
 */
function featuredCard(row) {
  const src = coverSrc(row);
  const cover = src
    ? h(
        'div',
        { class: 'review-featured-cover' },
        h('img', {
          src,
          alt: '',
          loading: 'lazy',
          onerror: (event) => {
            const image = event.target;
            image.style.display = 'none';
            const box = image.parentElement;
            if (box?.append) box.append('🎴');
          },
        }),
      )
    : h('div', { class: 'review-featured-cover placeholder' }, '🎴');
  if (!row) {
    return h('div', { class: 'review-featured' }, cover, h('div', { class: 'review-featured-info' }, h('div', { class: 'review-featured-kicker' }, '★ 本月最爱'), h('div', { class: 'review-featured-name' }, '还没有记录')));
  }
  const share = Math.min(100, Math.max(2, Number(row.share ?? 0)));
  return h(
    'div',
    { class: 'review-featured' },
    cover,
    h(
      'div',
      { class: 'review-featured-info' },
      h('div', { class: 'review-featured-kicker' }, '★ 本月最爱'),
      h('div', { class: 'review-featured-name', title: row.name }, row.name),
      h('div', { class: 'review-featured-value' }, `${tokens(row.tokens)} token · 占 ${row.share ?? 0}%`),
      h('div', { class: 'review-progress' }, h('i', { style: { width: `${share}%` } })),
    ),
  );
}

/** 一行横条：左边名，右边数值，中间按最大值铺宽度。 */
function barRow(label, value, max, text) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return h(
    'div',
    { class: 'kv-row' },
    h('span', { class: 'mono', style: { minWidth: '96px', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
    h('span', { class: 'heat-bar', style: { flex: '1', minWidth: '110px' } },
      h('span', { class: 'heat-fill', style: { width: `${pct}%` } }),
    ),
    h('span', { class: 'heat-num' }, text),
  );
}

/** 带封面的角色卡：复用卡库的 .card-grid 那套样式。 */
function cardCover(row, rank) {
  const src = coverSrc(row);
  const cover = src
    ? h('img', { class: 'card-grid-cover-img', src, alt: '', loading: 'lazy', onerror: (event) => fallbackCover(event.target, 'card-grid-cover-img', '🃏', '没有封面') })
    : h(
        'div',
        { class: 'card-grid-cover-img placeholder' },
        h('div', { class: 'card-grid-ph-icon' }, '🃏'),
        h('div', { class: 'card-grid-ph-text' }, '没有封面'),
      );
  return h(
    'div',
    { class: 'card-grid-item' },
    h(
      'div',
      { class: 'card-grid-cover', title: `${row.name}：${tokens(row.tokens)} token` },
      cover,
      h('span', { class: 'card-grid-badge' }, `#${rank} · ${row.share ?? 0}%`),
    ),
    h('div', { class: 'card-grid-title', title: row.name }, row.name),
    h('div', { class: 'card-grid-sub' }, `${tokens(row.tokens)} token · ${row.turns} 轮`),
  );
}

/** 本月出的一张图：点开看大图。 */
function galleryItem(assetId) {
  const url = `/api/assets/${encodeURIComponent(assetId)}/file`;
  return h(
    'div',
    { class: 'card-grid-item' },
    h(
      'div',
      { class: 'card-grid-cover', title: '点开看大图', onclick: () => window.open(url, '_blank', 'noopener') },
      h('img', {
        class: 'card-grid-cover-img',
        src: url,
        alt: '',
        loading: 'lazy',
        // 素材可能已经被删了：这张就整块撤掉，别留一个裂图。
        onerror: (event) => {
          const card = event.target.closest?.('.card-grid-item');
          if (card?.remove) card.remove();
          else event.target.style.display = 'none';
        },
      }),
    ),
  );
}

/**
 * 一根柱子。
 * 高度用**算好的像素**而不是百分比：柱子外面套着 flex 容器，百分比高度在那儿解析不出来
 * （会全部塌成小短条）。直接算 px 最稳。
 */
function barColumn(value, max, title, label, area = 100) {
  const height = value > 0 ? Math.max(4, Math.round((value / max) * area)) : 0;
  return h(
    'div',
    { style: { flex: '1', minWidth: '4px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }, title },
    h('div', { style: { width: '100%', height: `${height}px`, borderRadius: '4px 4px 0 0', background: 'linear-gradient(180deg, var(--st-accent), var(--st-accent-2))' } }),
    h('div', { class: 'heat-num', style: { marginTop: '4px', whiteSpace: 'nowrap' } }, label),
  );
}

/** 每天聊了多少条：月报 31 根、年报 12 根。 */
function dailyChart(series) {
  const max = Math.max(1, ...series.map((row) => Number(row.messages ?? 0)));
  const step = series.length > 20 ? 5 : series.length > 12 ? 2 : 1;
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'flex-end', gap: '2px', marginTop: '10px' } },
    series.map((row, index) =>
      barColumn(Number(row.messages ?? 0), max, `${row.date ?? row.key ?? ''}：${row.messages ?? 0} 条`, index % step === 0 ? (row.label ?? '') : '', 110),
    ),
  );
}

/** 一排放竖直柱子：时段（24 根）和星期（7 根）都用它，比一行一行列省地方。 */
function barChart(rows, unit = '') {
  const max = Math.max(1, ...rows.map((row) => Number(row.value ?? 0)));
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'flex-end', gap: '4px', marginTop: '10px' } },
    rows.map((row) => barColumn(Number(row.value ?? 0), max, `${row.label}：${row.value ?? 0} ${unit}`, row.short ?? '', 96)),
  );
}

/** 两块并列：各自包一层 div，免得 `.panel + .panel` 的间距把网格顶歪。 */
function sideBySide(left, right) {
  return h('div', { class: 'grid-2' }, h('div', {}, left), h('div', {}, right));
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function saveAsFile(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function createReviewView(module) {
  const el = h('div', { class: 'view' });
  const controlsHost = h('div', {});
  const summaryHost = h('div', {});
  const cardsHost = h('div', {});
  const splitHost = h('div', {});
  const activityHost = h('div', {});
  const galleryHost = h('div', {});
  const cloudHost = h('div', {});
  const friendsHost = h('div', {});
  const companionHost = h('div', {});
  const pagerRow = h('div', { class: 'chip-row' });
  const pageHost = h('div', {});
  let lastReport = null;
  let pageIndex = 0;

  const state = { scope: 'month', period: null, periods: null };
  const scopeRow = h('div', { class: 'chip-row' });
  const periodSelect = h('select', {});
  periodSelect.style.width = 'auto';
  periodSelect.style.minWidth = '160px';
  periodSelect.style.flex = '0 0 auto';
  periodSelect.addEventListener('change', () => {
    state.period = periodSelect.value || null;
    void refresh();
  });

  // 分页：一屏一个主题（照 PotatoVN 年报那种翻页感觉），别一路往下堆
  const PAGES = [
    { id: 'overview', title: '概览', hosts: () => [summaryHost] },
    { id: 'cards', title: '陪你最多的卡', hosts: () => [cardsHost, cloudHost] },
    { id: 'cost', title: '花费与创作', hosts: () => [splitHost] },
    { id: 'life', title: '陪伴与老友', hosts: () => [activityHost, friendsHost, companionHost] },
    { id: 'gallery', title: '本月出图', hosts: () => [galleryHost] },
  ];

  function renderPager() {
    pagerRow.replaceChildren(
      ...PAGES.map((page, index) =>
        h('button', { class: `chip-btn${index === pageIndex ? ' active' : ''}`, onclick: () => showPage(index) }, page.title),
      ),
      h('button', { class: 'btn small', onclick: () => exportReport(lastReport) }, '导出报告'),
    );
  }

  function showPage(index) {
    pageIndex = Math.max(0, Math.min(PAGES.length - 1, Number(index) || 0));
    pageHost.replaceChildren(...PAGES[pageIndex].hosts());
    renderPager();
  }

  el.append(controlsHost, pagerRow, pageHost);

  function renderControls(meta) {
    const scopes = state.periods?.scopes ?? ['month', 'year', 'all'];
    const labels = { month: '月报', year: '年报', all: '全部时间' };
    scopeRow.replaceChildren(
      ...scopes.map((scope) =>
        h(
          'button',
          {
            class: `chip-btn${state.scope === scope ? ' active' : ''}`,
            onclick: () => {
              if (state.scope === scope) return;
              state.scope = scope;
              state.period = null;
              renderControls(meta);
              void refresh();
            },
          },
          labels[scope] ?? scope,
        ),
      ),
    );

    let options = [];
    if (state.scope === 'month') {
      options = (state.periods?.months ?? []).map((value) => ({ value, label: value.replace('-', ' 年 ') + ' 月' }));
      if (!options.length && state.periods?.currentMonth) options = [{ value: state.periods.currentMonth, label: state.periods.currentMonth }];
    } else if (state.scope === 'year') {
      options = (state.periods?.years ?? []).map((value) => ({ value, label: `${value} 年` }));
      if (!options.length && state.periods?.currentYear) options = [{ value: state.periods.currentYear, label: `${state.periods.currentYear} 年` }];
    }
    if (state.scope !== 'all' && !state.period && options.length) state.period = options[0].value;
    periodSelect.replaceChildren(...options.map((item) => h('option', { value: item.value }, item.label)));
    if (state.period) periodSelect.value = state.period;
    periodSelect.style.display = state.scope === 'all' ? 'none' : '';

    controlsHost.replaceChildren(
      panel(
        '时间范围',
        meta?.label ?? '',
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '12px' } }, scopeRow, periodSelect),
      ),
    );
  }

  function renderSummary(report) {
    const head = report.headline ?? {};
    const lines = Array.isArray(report.commentary) ? report.commentary : [];
    const top = report.usage?.topCharacters?.[0] ?? null;
    const compare = report.compare;
    const deltaText = (value) => `${Number(value) > 0 ? '+' : ''}${value}%`;
    const badges = report.badges ?? [];
    const narration = report.__narration ?? null;
    summaryHost.replaceChildren(
      panel(
        '概览',
        lines.length ? lines.join('　') : '',
        h(
          'div',
          { class: 'review-hero' },
          featuredCard(top),
          h(
            'div',
            { class: 'review-metrics' },
            metric('🔁', `${head.turns ?? 0} 轮`, `${head.messages ?? 0} 条消息`),
            metric('🧮', tokens(head.tokens), `约 ¥${money(head.cost)}`),
            metric('✍️', words(head.words), '共写的字'),
            metric('📅', `${head.activeDays ?? 0} 天`, '活跃天数'),
            metric('🎴', `${head.cardsPlayed ?? 0} 张`, '说过话的卡'),
            metric('🃏', `${head.cardsCreated ?? 0} 张`, '新建的卡'),
          ),
        ),
        compare
          ? h(
              'div',
              { class: 'chip-row', style: { marginTop: '12px' } },
              h('span', { class: 'panel-note' }, `对比${compare.label}：`),
              h('span', { class: 'chip' }, `token ${deltaText(compare.tokens)}`),
              h('span', { class: 'chip' }, `轮数 ${deltaText(compare.turns)}`),
              h('span', { class: 'chip' }, `花费 ${deltaText(compare.cost)}`),
              h('span', { class: 'chip' }, `活跃天数 ${deltaText(compare.activeDays)}`),
            )
          : null,
        badges.length
          ? h(
              'div',
              { style: { marginTop: '12px' } },
              h('div', { class: 'panel-note', style: { marginBottom: '6px' } }, '徽章'),
              h('div', { class: 'chip-row' }, badges.map((badge) => h('span', { class: 'chip', title: badge.desc }, `${badge.icon} ${badge.title}`))),
            )
          : null,
        h(
          'div',
          { style: { marginTop: '14px' } },
          h('button', { class: 'btn', onclick: () => void writeNarration() }, '✒️ 让模型写一段回顾（会花 token）'),
          narration ? h('div', { class: 'panel-note', style: { marginTop: '8px', whiteSpace: 'pre-wrap', lineHeight: '1.7' } }, narration) : null,
        ),
      ),
    );
  }

  /** AI 旁白：会花 token，所以先问一句再发。 */
  async function writeNarration() {
    if (!lastReport) return;
    if (!confirm('让模型读这期的统计写一段回顾？这会花一点 token。')) return;
    try {
      const result = await post('/api/review/narration', { scope: state.scope, period: state.period });
      lastReport = { ...lastReport, __narration: result.text || '（模型没写出内容）' };
      renderSummary(lastReport);
      toast('写好了');
    } catch (err) {
      toastError(err);
    }
  }

  /** 词云：这期玩过的卡身上带的标签，按 token 加权，字号跟着权重走。 */
  function renderCloud(report) {
    const cloud = report.wordCloud ?? [];
    const size = (weight) => `${13 + Math.round(Number(weight ?? 0) * 12)}px`;
    cloudHost.replaceChildren(
      panel(
        '词云',
        cloud.length ? `这期出现过的标签 · ${cloud.length} 个` : '',
        cloud.length
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'baseline', lineHeight: '1.9' } },
              cloud.map((item) =>
                h(
                  'span',
                  {
                    style: { fontSize: size(item.weight), color: `rgba(199,107,155,${0.55 + Number(item.weight ?? 0) * 0.45})` },
                    title: `${item.tag} · 来自 ${item.characters.join('、')}`,
                  },
                  translateTag(item.tag).label,
                ),
              ),
            )
          : emptyState({ icon: '☁️', title: '还没有标签可画', desc: '给这期聊过的卡打上标签，这里就会长出词云。' }),
      ),
    );
  }

  /** 新认识 / 久别重逢 / 被冷落。 */
  function renderFriends(report) {
    const { fresh = [], returning = [], cold = [] } = report.lifelines ?? {};
    const block = (title, icon, items, note) =>
      panel(
        title,
        items.length ? `${items.length} 位` : '',
        items.length
          ? h(
              'div',
              { class: 'chip-row' },
              items.map((item) => h('span', { class: 'chip', title: note(item) }, `${icon} ${item.name ?? '（未命名）'}`)),
            )
          : h('div', { class: 'panel-note' }, '这一期没有'),
      );
    friendsHost.replaceChildren(
      block('这期新认识', '🆕', fresh, (item) => `第一次说话：${String(item.at ?? '').slice(0, 10)}`),
      block('久别重逢', '🤝', returning, (item) => `隔了 ${item.days} 天又回来`),
      block('这期没出现的卡', '💤', cold, (item) => `上期还在聊，最后一次是 ${String(item.lastAt ?? '').slice(0, 10)}`),
    );
  }

  /** 陪伴时长（估算）+ 重生 + 演出解锁。 */
  function renderCompanion(report) {
    const companion = report.companion ?? {};
    const unlocks = report.unlocks ?? {};
    const minutes = Math.round(Number(companion.seconds ?? 0) / 60);
    const duration =
      minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : minutes > 0 ? `${minutes} 分钟` : '不到 1 分钟';
    companionHost.replaceChildren(
      panel(
        '陪伴与产出',
        companion.estimated ? '时长是估算（按消息间隔推的）' : '',
        kv([
          ['陪伴时长', companion.sessions ? `${duration}（约 ${companion.sessions} 场）` : '这一期还没聊'],
          ['重写了多少次', `${report.regenerations ?? 0} 次`],
          ['解锁结局', `${unlocks.endings ?? 0} 个`],
          ['解锁 CG', `${unlocks.cg ?? 0} 张`],
          ['解锁路线', `${unlocks.routes ?? 0} 条`],
        ]),
        h('div', { class: 'panel-note', style: { marginTop: '8px' } }, `估算口径：同一个对话里相邻消息间隔小于 ${companion.gapMinutes ?? 30} 分钟算同一场；挂着页面没说话的时间算不进去。`),
      ),
    );
  }

  function renderCards(report) {
    const top = report.usage?.topCharacters ?? [];
    cardsHost.replaceChildren(
      panel(
        '陪你最多的卡',
        top.length ? `按 token 排序 · 前 ${top.length} 张` : '',
        top.length
          ? h('div', { class: 'card-grid' }, top.map((row, index) => cardCover(row, index + 1)))
          : emptyState({ icon: '🎴', title: '还没有用量记录', desc: '去聊几句，这里就会出现你聊得最多的卡。' }),
      ),
    );
  }

  function renderSplit(report) {
    const usage = report.usage ?? {};
    const creation = report.creation ?? {};
    const images = report.images ?? {};
    const models = usage.byModel ?? [];
    const maxModel = Math.max(1, ...models.map((row) => Number(row.tokens ?? 0)));

    const usagePanel = panel(
      '花费与产量',
      `${usage.turns ?? 0} 轮`,
      kv([
        ['输入 token', tokens(usage.promptTokens)],
        ['输出 token', tokens(usage.completionTokens)],
        ['合计 token', tokens(usage.totalTokens)],
        ['花费', `¥${money(usage.cost)}`],
        ['缓存节省', usage.cachedTokens ? `¥${money(usage.cacheSavings)}（命中率 ${report.cacheHitRate ?? 0}%）` : '提供方未上报缓存命中'],
        ['未配单价', `${usage.unpricedTurns ?? 0} 轮`],
      ]),
      h(
        'div',
        { style: { marginTop: '14px' } },
        h('div', { class: 'panel-note' }, '按模型'),
        models.length
          ? h('div', {}, models.map((row) => barRow(row.model, Number(row.tokens ?? 0), maxModel, `${tokens(row.tokens)} · ${row.turns} 轮`)))
          : emptyState({ icon: '🌌', title: '还没有按模型的用量' }),
      ),
    );

    const creationPanel = panel(
      '创作与出图',
      null,
      table(
        ['项目', '数量'],
        [
          ['新建角色卡', creation.cardsCreated ?? 0],
          ['改动过的角色卡', creation.cardsEdited ?? 0],
          ['卡版本数', creation.cardVersions ?? 0],
          ['新建世界书', creation.worldbooks ?? 0],
          ['新建提示词预设', creation.presets ?? 0],
          ['新建记忆', creation.memories ?? 0],
          ['出图成功', images.done ?? 0],
          ['出图失败', images.failed ?? 0],
        ],
      ),
    );

    splitHost.replaceChildren(sideBySide(usagePanel, creationPanel));
  }

  function renderActivity(report) {
    const activity = report.activity ?? {};
    const byHour = activity.byHour ?? [];
    const byWeekday = activity.byWeekday ?? [];
    const series = activity.byDay ?? [];
    const peakHours = [...byHour].filter((row) => Number(row.messages ?? 0) > 0).sort((a, b) => b.messages - a.messages).slice(0, 3);
    activityHost.replaceChildren(
      panel(
        '陪伴与活跃',
        activity.peak ? `峰值日 ${activity.peak.date}` : '',
        kv([
          ['消息条数', `${activity.messages ?? 0} 条`],
          ['你写的字', words(activity.userWords)],
          ['AI 写的字', words(activity.assistantWords)],
          ['最长一条回复', `${words(activity.longestMessage)} 字`],
          ['活跃天数', `${activity.activeDays ?? 0} 天（最长连续 ${activity.longestStreak ?? 0} 天）`],
          ['新开对话', `${activity.newChats ?? 0} 个（分支 ${activity.branches ?? 0} 个）`],
          ['最活跃时段', peakHours.length ? peakHours.map((row) => `${String(row.hour).padStart(2, '0')} 点`).join('、') : '—'],
          ['凌晨消息', `${activity.nightMessages ?? 0} 条（0–5 点）`],
        ]),
        series.length
          ? h('div', { style: { marginTop: '14px' } }, h('div', { class: 'panel-note' }, '每天聊了多少条'), dailyChart(series))
          : null,
      ),
      sideBySide(
        panel(
          '时段分布',
          '按本地时间',
          barChart(byHour.map((row) => ({ label: `${String(row.hour).padStart(2, '0')}:00`, short: row.hour % 3 === 0 ? String(row.hour) : '', value: Number(row.messages ?? 0) })), '条'),
        ),
        panel('星期分布', null, barChart(byWeekday.map((row) => ({ label: WEEKDAYS[row.weekday] ?? row.label ?? '', short: '日一二三四五六'[row.weekday] ?? '', value: Number(row.messages ?? 0) })), '条')),
      ),
    );
  }

  function renderGallery(report) {
    const gallery = report.images?.gallery ?? [];
    galleryHost.replaceChildren(
      panel(
        '本月出图',
        gallery.length ? `${gallery.length} 张 · 点开看大图` : '',
        gallery.length
          ? h('div', { class: 'card-grid' }, gallery.map((assetId) => galleryItem(assetId)))
          : emptyState({ icon: '🖼️', title: '这段时间还没出图', desc: '拿 ComfyUI 出一张，或者让它按场景自动出。' }),
      ),
    );
  }

  async function refresh() {
    const query = `scope=${encodeURIComponent(state.scope)}${state.period ? `&period=${encodeURIComponent(state.period)}` : ''}`;
    try {
      const report = await get(`/api/review/report?${query}`);
      lastReport = report;
      renderControls(report.meta);
      renderSummary(report);
      renderCards(report);
      renderSplit(report);
      renderActivity(report);
      renderCloud(report);
      renderFriends(report);
      renderCompanion(report);
      renderGallery(report);
      showPage(pageIndex);
    } catch (err) {
      summaryHost.replaceChildren(panel('月报 / 年报', null, errorBox(err, { onRetry: refresh })));
      cardsHost.replaceChildren();
      splitHost.replaceChildren();
      activityHost.replaceChildren();
      cloudHost.replaceChildren();
      friendsHost.replaceChildren();
      companionHost.replaceChildren();
      galleryHost.replaceChildren();
      toastError(err);
    }
  }

  /** 导出：生成一份自包含 HTML，浏览器里能直接打印成 PDF（也方便当长图存）。 */
  function exportReport(report) {
    if (!report) return;
    const head = report.headline ?? {};
    const rows = [
      ['时间范围', report.meta?.label ?? ''],
      ['聊了多少轮', head.turns ?? 0],
      ['消息条数', head.messages ?? 0],
      ['消耗 token', head.tokens ?? 0],
      ['花费', `¥${money(head.cost)}`],
      ['写下的字', head.words ?? 0],
      ['活跃天数', `${head.activeDays ?? 0}（最长连续 ${head.longestStreak ?? 0} 天）`],
      ['玩了几张卡', head.cardsPlayed ?? 0],
      ['写了几张卡', head.cardsCreated ?? 0],
      ['重写了多少次', report.regenerations ?? 0],
      ['解锁结局 / CG', `${report.unlocks?.endings ?? 0} / ${report.unlocks?.cg ?? 0}`],
      ['陪伴时长（估算）', `${Math.round(Number(report.companion?.seconds ?? 0) / 60)} 分钟`],
    ];
    const top = report.usage?.topCharacters ?? [];
    const tags = report.wordCloud ?? [];
    const friends = report.lifelines ?? {};
    const friendRow = (title, items, note) =>
      items?.length
        ? `<tr><td>${escapeHtml(title)}</td><td>${items.map((item) => `${escapeHtml(item.name ?? '')}（${escapeHtml(note(item))}）`).join('、')}</td></tr>`
        : '';
    const style = [
      'body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;margin:34px;color:#3a2a3a;background:#fff;line-height:1.6}',
      'h1{font-size:22px;margin:0 0 2px}',
      'h2{font-size:15px;margin:24px 0 8px;color:#a2557f}',
      'table{border-collapse:collapse;font-size:13px}',
      'td{padding:4px 16px 4px 0;vertical-align:top}',
      'td:first-child{color:#8a7794;white-space:nowrap}',
      '.cloud{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline}',
      '.nar{margin:10px 0 0;padding:12px 14px;background:#fdf6fa;border-left:3px solid #e8a0bf;white-space:pre-wrap}',
      '.badges span{display:inline-block;margin:0 8px 6px 0;padding:2px 10px;border-radius:999px;background:#fdf6fa;border:1px solid #f0d6e4;font-size:12px}',
      'footer{margin-top:28px;color:#b9a7c0;font-size:11px}',
    ].join('\n');
    const parts = [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      `<title>Silver Tavern · ${escapeHtml(report.meta?.label ?? '报告')}</title>`,
      `<style>\n${style}\n</style></head><body>`,
      '<h1>Silver Tavern · 月度 / 年度报告</h1>',
      `<div style="color:#8a7794;font-size:13px">${escapeHtml(report.meta?.label ?? '')}</div>`,
      report.__narration ? `<p class="nar">${escapeHtml(report.__narration)}</p>` : '',
      (report.badges ?? []).length
        ? `<div class="badges">${report.badges.map((badge) => `<span>${escapeHtml(badge.icon)} ${escapeHtml(badge.title)}</span>`).join('')}</div>`
        : '',
      '<h2>概览</h2><table>',
      rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(String(value ?? ''))}</td></tr>`).join(''),
      '</table>',
      '<h2>陪你最多的卡</h2><table>',
      top.map((row) => `<tr><td>${escapeHtml(row.name ?? '')}</td><td>${row.tokens} token · ${row.turns} 轮 · ${row.share}%</td></tr>`).join('') || '<tr><td>（这期没有记录）</td></tr>',
      '</table>',
      '<h2>词云</h2><div class="cloud">',
      tags.map((item) => `<span style="font-size:${13 + Math.round(Number(item.weight ?? 0) * 12)}px;color:rgba(199,107,155,${0.55 + Number(item.weight ?? 0) * 0.45})">${escapeHtml(item.tag)}</span>`).join('') || '（这期没有标签）',
      '</div>',
      '<h2>新朋友 / 老朋友</h2><table>',
      friendRow('这期新认识', friends.fresh, (item) => `第一次：${String(item.at ?? '').slice(0, 10)}`),
      friendRow('久别重逢', friends.returning, (item) => `隔了 ${item.days} 天`),
      friendRow('这期没出现', friends.cold, (item) => `上次 ${String(item.lastAt ?? '').slice(0, 10)}`),
      '</table>',
      '<footer>由 Silver Tavern 生成 · 在浏览器里可以直接打印成 PDF</footer>',
      '</body></html>',
    ];
    saveAsFile(`silver-tavern-${report.meta?.period ?? 'all'}.html`, parts.filter(Boolean).join('\n'), 'text/html');
    toast('导出好了（打开后可以打印成 PDF）');
  }

  async function mount() {
    controlsHost.append(loading());
    try {
      state.periods = await get('/api/review/periods');
    } catch {
      state.periods = { scopes: ['month', 'year', 'all'], months: [], years: [] };
    }
    renderControls(null);
    summaryHost.append(loading());
    await refresh();
  }

  return { el, mount };
}
