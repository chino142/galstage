/**
 * 采样参数表的单元测试。
 *
 * 这一层是"界面能填的 = 真发得出去的"的唯一保证：界面照它渲染、保存照它校验、
 * 适配器照它映射字段。所以这里重点钉住：**不同适配器的字段确实不一样**，
 * 以及越界/错类型会被挡住。
 */

import assert from 'node:assert/strict';

import { ADAPTER_PARAM_SCHEMA, adapterParamForm, adapterParamMap, adapterParamSchema, validateAdapterParams } from '../server/providers/params.mjs';

export async function run() {
  // ── 表里每个适配器都有：标题、说明、参数列表 ──────────────────────
  for (const [id, schema] of Object.entries(ADAPTER_PARAM_SCHEMA)) {
    assert.ok(schema.title, `${id} 要有标题`);
    assert.ok(Array.isArray(schema.params) && schema.params.length, `${id} 要有参数`);
    for (const item of schema.params) {
      assert.ok(item.key, `${id} 的参数要有 key`);
      assert.ok(item.label, `${id}.${item.key} 要有界面标签`);
      assert.ok(['number', 'int', 'boolean', 'string', 'list', 'enum', 'json'].includes(item.type), `${id}.${item.key} 类型要认识`);
      if (item.type === 'enum') assert.ok(item.options?.length, `${id}.${item.key} 枚举要有选项`);
      if (item.type === 'number' || item.type === 'int') {
        assert.ok(Number.isFinite(item.min) && Number.isFinite(item.max), `${id}.${item.key} 要给范围`);
      }
    }
  }

  // ── 关键：不同适配器支持的东西真的不一样 ─────────────────────────
  const openai = new Set(ADAPTER_PARAM_SCHEMA.openai.params.map((p) => p.key));
  const anthropic = new Set(ADAPTER_PARAM_SCHEMA.anthropic.params.map((p) => p.key));
  const gemini = new Set(ADAPTER_PARAM_SCHEMA.gemini.params.map((p) => p.key));
  const text = new Set(ADAPTER_PARAM_SCHEMA.text.params.map((p) => p.key));
  assert.ok(openai.has('frequency_penalty') && openai.has('presence_penalty'), 'OpenAI 有惩罚项');
  assert.ok(!anthropic.has('frequency_penalty'), 'Anthropic 没有 frequency_penalty');
  assert.ok(anthropic.has('top_k'), 'Anthropic 有 top_k');
  assert.ok(!gemini.has('frequency_penalty'), 'Gemini 没有惩罚项');
  assert.ok(text.has('min_p') && text.has('repetition_penalty'), '本地那套有 min_p / repetition_penalty');
  assert.ok(!openai.has('min_p') === false, 'OpenAI 兼容也允许 min_p（本地后端可能认）');

  // Anthropic 的温度上限和其它家不同（0~1）
  assert.equal(ADAPTER_PARAM_SCHEMA.anthropic.params.find((p) => p.key === 'temperature').max, 1);
  assert.equal(ADAPTER_PARAM_SCHEMA.openai.params.find((p) => p.key === 'temperature').max, 2);

  // ── 字段映射：Gemini/Vertex 的叫法不一样 ─────────────────────────
  assert.equal(adapterParamMap('gemini').top_p, 'topP');
  assert.equal(adapterParamMap('gemini').top_k, 'topK');
  assert.equal(adapterParamMap('openai').top_p, 'top_p');
  assert.equal(adapterParamMap('openai').max_tokens, 'max_tokens');
  // 适配器自己处理的字段（Anthropic/Gemini 的 max_tokens）不该进通用映射，避免发两次
  assert.equal(adapterParamMap('anthropic').max_tokens, undefined);
  assert.equal(adapterParamMap('gemini').max_tokens, undefined);
  assert.equal(adapterParamMap('anthropic').stop, undefined);
  // 认不出的适配器回退到 OpenAI 方言
  assert.equal(adapterParamSchema('nope').id, 'openai');
  assert.equal(adapterParamMap('nope').temperature, 'temperature');

  // ── 界面用的表单描述：不带内部字段，只留要渲染的 ─────────────────
  const form = adapterParamForm('anthropic');
  assert.equal(form.id, 'anthropic');
  const tempField = form.params.find((p) => p.key === 'temperature');
  assert.equal(tempField.max, 1);
  assert.equal(tempField.field, undefined, '表单描述不该暴露内部字段名');

  // ── 校验：范围 / 类型 / 枚举 / 列表 / JSON ───────────────────────
  assert.throws(() => validateAdapterParams('openai', { temperature: 9 }), /temperature/, '温度越界要报错');
  assert.throws(() => validateAdapterParams('anthropic', { temperature: 1.5 }), /temperature/, 'Anthropic 上限更严');
  assert.throws(() => validateAdapterParams('openai', { max_tokens: 0 }), /max_tokens/, '上限不能是 0');
  assert.throws(() => validateAdapterParams('openai', { reasoning_effort: 'ultra' }), /reasoning_effort/, '枚举外的值要挡住');
  assert.throws(() => validateAdapterParams('openai', { logit_bias: 'not json' }), /JSON/, 'JSON 字段要能验出来');

  const cleaned = validateAdapterParams('openai', { temperature: '0.9', max_tokens: '2048', stop: 'A\nB\n', logprobs: 'true' });
  assert.deepEqual(cleaned, { temperature: 0.9, max_tokens: 2048, stop: ['A', 'B'], logprobs: true }, '字符串要转成正确的类型，空行要丢掉');

  // 留空 = 不发送（不是发 null）
  assert.deepEqual(validateAdapterParams('openai', { temperature: '', max_tokens: null }), {});

  // 表外字段保留：各家奇特的参数不该因为表里没有就被丢掉
  assert.deepEqual(validateAdapterParams('openai', { custom_flag: true }), { custom_flag: true });

  // JSON 字段允许直接传对象
  assert.deepEqual(validateAdapterParams('openai', { logit_bias: { '50256': -100 } }), { logit_bias: { '50256': -100 } });
}
