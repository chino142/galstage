/** 设置页。骨架里唯一"真能用"的功能：读 schema → 生成表单 → 保存 → 立即生效。 */

import { h } from '../core/dom.mjs';
import { get, put, post } from '../core/api.mjs';
import { panel, field, errorBox, loading } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { applyTheme } from '../ui/theme.mjs';
import { groupLabel, optionLabel, setLocale, settingLabel, t } from '../core/i18n.mjs';
import { patchSettings } from '../core/prefs.mjs';
import { requestNotifyPermission } from '../ui/notify.mjs';
import { confirmDialog } from '../ui/modal.mjs';

function controlFor(item, value, changed) {
  if (item.type === 'enum') {
    return h(
      'select',
      { onchange: (event) => changed(item.key, event.target.value) },
      item.options.map((option) => h('option', { value: option, selected: option === value }, optionLabel(option))),
    );
  }
  // 浏览器通知要授权：只在打开开关这一刻请求一次；被拒绝就把开关拨回去、只提示一句。
  if (item.key === 'ui.notifyBrowser') {
    return h('input', {
      type: 'checkbox',
      checked: Boolean(value),
      style: { width: '18px', height: '18px' },
      onchange: async (event) => {
        if (!event.target.checked) return changed(item.key, false);
        const result = await requestNotifyPermission();
        if (result === 'granted') {
          toast(t('settings.notifyGranted'));
          changed(item.key, true);
        } else {
          event.target.checked = false;
          toast(result === 'unsupported' ? t('settings.notifyUnsupported') : t('settings.notifyDenied'), { tone: 'warn', duration: 5200 });
        }
      },
    });
  }
  if (item.type === 'boolean') {
    return h('input', {
      type: 'checkbox',
      checked: Boolean(value),
      style: { width: '18px', height: '18px' },
      onchange: (event) => changed(item.key, event.target.checked),
    });
  }
  if (item.type === 'number') {
    return h('input', {
      type: 'number',
      value,
      min: item.minimum ?? null,
      max: item.maximum ?? null,
      step: item.key.includes('Scale') ? '0.05' : '1',
      oninput: (event) => changed(item.key, Number(event.target.value)),
    });
  }
  // 长文本（自定义 CSS、背景图库 JSON）用多行框，单行框写 CSS 太难受
  const longForm = item.key.toLowerCase().includes('css') || String(item.default ?? '').length > 80 || item.key === 'ui.backgroundGallery';
  if (longForm) {
    return h('textarea', {
      class: 'text_pole',
      rows: 5,
      spellcheck: 'false',
      value: String(value ?? ''),
      oninput: (event) => changed(item.key, event.target.value),
    });
  }
  return h('input', { type: 'text', value, oninput: (event) => changed(item.key, event.target.value) });
}

export function createSettingsView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const pending = {};
  let settings = { ...(ctx.appData?.settings ?? {}) };

  function changed(key, value) {
    pending[key] = value;
    settings = { ...settings, ...pending };
    if (key === 'ui.language') setLocale(value);
    applyTheme(settings);
  }

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, t('settings.hint')),
      h(
        'div',
        { style: { marginTop: '14px', display: 'flex', gap: '8px' } },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              try {
                const result = await put('/api/settings', pending);
                settings = result.settings;
                applyTheme(settings);
                patchSettings(settings);
                setLocale(settings['ui.language'] ?? 'zh-CN');
                ctx.onSettingsSaved?.(settings);
                toast(t('settings.saved'));
              } catch (err) {
                toastError(err);
              }
            },
          },
          t('btn.save'),
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              location.reload();
            },
          },
          t('settings.reload'),
        ),
      ),
    ),
    host,
  );

  async function mount() {
    host.append(loading());
    try {
      const schema = ctx.appData?.settingsSchema ?? (await get('/api/settings/schema')).items;
      const byGroup = new Map();
      for (const item of schema) {
        if (item.hidden) continue; // 界面自己记的状态项不进设置页
        if (!byGroup.has(item.group)) byGroup.set(item.group, []);
        byGroup.get(item.group).push(item);
      }
      host.replaceChildren(
        ...[...byGroup.entries()].map(([group, items]) =>
          panel(
            groupLabel(group),
            `${items.length} 项`,
            items.map((item) =>
              field(settingLabel(item), controlFor(item, settings[item.key], changed), t(`setting.${item.key}.help`, null, item.help)),
            ),
          ),
        ),
        updatePanel(),
      );
    } catch (err) {
      host.replaceChildren(panel('设置', null, errorBox(err)));
    }
  }

  function updatePanel() {
    const status = h('div', { class: 'panel-note' }, '');
    const installBtn = h('button', {
      class: 'btn primary',
      style: { display: 'none' },
      onclick: () => void install(),
    }, '更新并重启');
    const checkBtn = h('button', { class: 'btn', onclick: () => void check() }, '检查更新');

    async function check() {
      status.textContent = '正在检查…';
      installBtn.style.display = 'none';
      try {
        const info = await get('/api/system/update');
        if (!info.configured) {
          status.textContent = info.note ?? '还没配置更新源';
          return;
        }
        if (info.hasUpdate) {
          status.textContent = `有更新：${info.current} → ${info.latest}${info.notes ? `（${info.notes}）` : ''}`;
          installBtn.style.display = '';
        } else {
          status.textContent = `已是最新版本（${info.current}）`;
        }
      } catch (err) {
        toastError(err);
        status.textContent = '检查失败';
      }
    }

    async function install() {
      const answer = await confirmDialog({
        title: '更新并重启',
        message: '会下载新版本、退出当前程序、替换 exe，然后自动重新启动。确定吗？',
        confirmLabel: '更新并重启',
      });
      if (!answer) return;
      status.textContent = '正在下载新版本…';
      installBtn.disabled = true;
      try {
        const result = await post('/api/system/update/install', {});
        status.textContent = result.restarting ? '已就绪，即将自动重启…' : (result.note ?? '完成');
      } catch (err) {
        toastError(err);
        status.textContent = '更新失败';
        installBtn.disabled = false;
      }
    }

    return panel(
      '检查更新',
      null,
      h('div', { class: 'panel-note' }, '先在设置里填好「更新源地址」，点「检查更新」看有没有新版本；有的话点「更新并重启」，程序会自己下载、替换 exe 并重新启动。'),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' } }, checkBtn, installBtn, status),
    );
  }

  return { el, mount };
}
