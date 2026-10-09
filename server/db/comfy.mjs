/**
 * ComfyUI 的存储层：工作流定义与出图记录。
 *
 * 和别的 store 一样，行到对象时统一做 JSON 解析，别让 core / 路由关心存储细节。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';

const WORKFLOW_COLUMNS = 'id, name, kind, workflow, bindings, seed, note, enabled, created_at, updated_at';
const RUN_COLUMNS = 'id, workflow_id, workflow_name, kind, chat_id, message_id, prompt_id, status, node_id, progress, progress_max, step_label, params, images, reason, error, created_at, updated_at';
const BINDING_COLUMNS = 'character_id, workflow_id, lora_text, expressions, note, updated_at';
const LORA_SET_COLUMNS = 'id, name, loras, note, created_at, updated_at';
const OUTFIT_COLUMNS = 'character_id, outfits, active_id, negative, updated_at';

function outfitToObject(row) {
  if (!row) return null;
  const outfits = fromJson(row.outfits, []);
  return {
    characterId: row.character_id,
    outfits: Array.isArray(outfits) ? outfits : [],
    activeId: row.active_id ?? null,
    negative: row.negative ?? '',
    updatedAt: row.updated_at,
  };
}

function loraSetToObject(row) {
  if (!row) return null;
  const loras = fromJson(row.loras, []);
  return {
    id: row.id,
    name: row.name,
    loras: Array.isArray(loras) ? loras : [],
    note: row.note ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bindingToObject(row) {
  if (!row) return null;
  return {
    characterId: row.character_id,
    workflowId: row.workflow_id ?? null,
    loraText: row.lora_text ?? null,
    expressions: fromJson(row.expressions, {}),
    note: row.note ?? null,
    updatedAt: row.updated_at,
  };
}

function workflowToObject(row) {
  if (!row) return null;
  const bindings = fromJson(row.bindings, []);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind ?? 'custom',
    workflow: row.workflow,
    bindings: Array.isArray(bindings) ? bindings : [],
    seed: row.seed === null || row.seed === undefined ? null : Number(row.seed),
    note: row.note ?? null,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runToObject(row) {
  if (!row) return null;
  const images = fromJson(row.images, []);
  return {
    id: row.id,
    workflowId: row.workflow_id ?? null,
    workflowName: row.workflow_name ?? null,
    kind: row.kind ?? null,
    chatId: row.chat_id ?? null,
    messageId: row.message_id ?? null,
    promptId: row.prompt_id ?? null,
    status: row.status ?? 'queued',
    nodeId: row.node_id ?? null,
    progress: row.progress === null || row.progress === undefined ? null : Number(row.progress),
    progressMax: row.progress_max === null || row.progress_max === undefined ? null : Number(row.progress_max),
    stepLabel: row.step_label ?? null,
    values: fromJson(row.params, {}),
    images: Array.isArray(images) ? images : [],
    reason: row.reason ?? null,
    error: row.error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createComfyStore({ repo }) {
  // ------------------------------------------------------------------ 工作流

  function listWorkflows({ kind = null, enabled = null, search = '' } = {}) {
    const where = [];
    const params = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (enabled !== null) {
      where.push('enabled = ?');
      params.push(enabled ? 1 : 0);
    }
    if (search) {
      where.push('name LIKE ?');
      params.push(`%${search}%`);
    }
    const sql = `SELECT ${WORKFLOW_COLUMNS} FROM comfy_workflows ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
    return repo.all(sql, params).map(workflowToObject);
  }

  function getWorkflow(id) {
    return workflowToObject(repo.get(`SELECT ${WORKFLOW_COLUMNS} FROM comfy_workflows WHERE id = ?`, [id]));
  }

  function insertWorkflow(input = {}) {
    const id = input.id ?? newId('cwf');
    const now = nowIso();
    repo.run(
      `INSERT INTO comfy_workflows (id, name, kind, workflow, bindings, seed, note, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.name ?? '未命名工作流',
        input.kind ?? 'custom',
        typeof input.workflow === 'string' ? input.workflow : JSON.stringify(input.workflow ?? {}),
        JSON.stringify(input.bindings ?? []),
        input.seed ?? null,
        input.note ?? null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      ],
    );
    return getWorkflow(id);
  }

  function updateWorkflow(id, patch = {}) {
    const columns = {
      name: 'name',
      kind: 'kind',
      workflow: 'workflow',
      bindings: 'bindings',
      seed: 'seed',
      note: 'note',
      enabled: 'enabled',
    };
    const coerce = {
      workflow: (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? {})),
      bindings: (value) => JSON.stringify(value ?? []),
      seed: (value) => (value === null ? null : Number(value)),
      enabled: (value) => (value ? 1 : 0),
    };
    const fields = [];
    const params = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      fields.push(`${column} = ?`);
      params.push(coerce[key] ? coerce[key](patch[key]) : patch[key]);
    }
    if (!fields.length) return getWorkflow(id);
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    repo.run(`UPDATE comfy_workflows SET ${fields.join(', ')} WHERE id = ?`, params);
    return getWorkflow(id);
  }

  function removeWorkflow(id) {
    const found = getWorkflow(id);
    if (!found) return false;
    repo.run('DELETE FROM comfy_workflows WHERE id = ?', [id]);
    return true;
  }

  // ------------------------------------------------------------------ LoRA 组合

  function listLoraSets() {
    return repo.all(`SELECT ${LORA_SET_COLUMNS} FROM comfy_lora_sets ORDER BY updated_at DESC`).map(loraSetToObject);
  }

  function getLoraSet(id) {
    if (!id) return null;
    return loraSetToObject(repo.get(`SELECT ${LORA_SET_COLUMNS} FROM comfy_lora_sets WHERE id = ?`, [String(id)]));
  }

  function saveLoraSet(input = {}) {
    const now = nowIso();
    const id = input.id ? String(input.id) : newId('loraset');
    const name = String(input.name ?? '').trim() || '未命名组合';
    const loras = JSON.stringify(Array.isArray(input.loras) ? input.loras : []);
    const existing = getLoraSet(id);
    if (existing) {
      repo.run('UPDATE comfy_lora_sets SET name = ?, loras = ?, note = ?, updated_at = ? WHERE id = ?', [
        name,
        loras,
        input.note ?? existing.note ?? null,
        now,
        id,
      ]);
    } else {
      repo.run('INSERT INTO comfy_lora_sets (id, name, loras, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        name,
        loras,
        input.note ?? null,
        now,
        now,
      ]);
    }
    return getLoraSet(id);
  }

  function removeLoraSet(id) {
    if (!getLoraSet(id)) return false;
    repo.run('DELETE FROM comfy_lora_sets WHERE id = ?', [String(id)]);
    return true;
  }

  // ------------------------------------------------------------------ 衣柜

  function getOutfits(characterId) {
    if (!characterId) return null;
    return outfitToObject(repo.get(`SELECT ${OUTFIT_COLUMNS} FROM comfy_outfits WHERE character_id = ?`, [String(characterId)]));
  }

  function saveOutfits(characterId, patch = {}) {
    const now = nowIso();
    const key = String(characterId);
    const existing = getOutfits(key);
    const outfits = JSON.stringify(Array.isArray(patch.outfits) ? patch.outfits : existing?.outfits ?? []);
    const activeId = patch.activeId !== undefined ? patch.activeId : existing?.activeId ?? null;
    const negative = patch.negative !== undefined ? String(patch.negative) : existing?.negative ?? '';
    if (existing) {
      repo.run('UPDATE comfy_outfits SET outfits = ?, active_id = ?, negative = ?, updated_at = ? WHERE character_id = ?', [
        outfits,
        activeId,
        negative,
        now,
        key,
      ]);
    } else {
      repo.run('INSERT INTO comfy_outfits (character_id, outfits, active_id, negative, updated_at) VALUES (?, ?, ?, ?, ?)', [
        key,
        outfits,
        activeId,
        negative,
        now,
      ]);
    }
    return getOutfits(key);
  }

  function removeOutfits(characterId) {
    if (!getOutfits(characterId)) return false;
    repo.run('DELETE FROM comfy_outfits WHERE character_id = ?', [String(characterId)]);
    return true;
  }

  // ------------------------------------------------------------------ 出图记录

  function listRuns({ chatId = null, workflowId = null, status = null, messageId = null, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (chatId) {
      where.push('chat_id = ?');
      params.push(chatId);
    }
    if (messageId) {
      where.push('message_id = ?');
      params.push(messageId);
    }
    if (workflowId) {
      where.push('workflow_id = ?');
      params.push(workflowId);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    params.push(Math.max(1, Math.min(500, Number(limit) || 50)));
    const sql = `SELECT ${RUN_COLUMNS} FROM comfy_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    return repo.all(sql, params).map(runToObject);
  }

  function getRun(id) {
    return runToObject(repo.get(`SELECT ${RUN_COLUMNS} FROM comfy_runs WHERE id = ?`, [id]));
  }

  function findRunByPromptId(promptId) {
    return runToObject(
      repo.get(`SELECT ${RUN_COLUMNS} FROM comfy_runs WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 1`, [promptId]),
    );
  }

  /** 这张图是哪次出图出的（"双击重出 / 改提示词"要靠它找回原工作流）。 */
  function findRunByAsset(assetId) {
    const key = String(assetId ?? '');
    if (!key) return null;
    // images 是一段 JSON 文本，SQL 里不好查；最近的记录里扫一遍就够（图都在最近的 run 上）
    const rows = repo.all(`SELECT ${RUN_COLUMNS} FROM comfy_runs ORDER BY created_at DESC LIMIT 400`);
    for (const row of rows) {
      const run = runToObject(row);
      if ((run.images ?? []).some((image) => String(image?.assetId ?? image) === key)) return run;
    }
    return null;
  }

  function insertRun(input = {}) {
    const id = input.id ?? newId('crun');
    const now = nowIso();
    repo.run(
      `INSERT INTO comfy_runs (id, workflow_id, workflow_name, kind, chat_id, message_id, prompt_id, status, node_id,
         progress, progress_max, step_label, params, images, reason, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workflowId ?? null,
        input.workflowName ?? null,
        input.kind ?? null,
        input.chatId ?? null,
        input.messageId ?? null,
        input.promptId ?? null,
        input.status ?? 'queued',
        input.nodeId ?? null,
        input.progress ?? null,
        input.progressMax ?? null,
        input.stepLabel ?? null,
        JSON.stringify(input.values ?? {}),
        JSON.stringify(input.images ?? []),
        input.reason ?? null,
        input.error ?? null,
        now,
        now,
      ],
    );
    return getRun(id);
  }

  function updateRun(id, patch = {}) {
    const columns = {
      status: 'status',
      nodeId: 'node_id',
      progress: 'progress',
      progressMax: 'progress_max',
      stepLabel: 'step_label',
      promptId: 'prompt_id',
      values: 'params',
      images: 'images',
      messageId: 'message_id',
      error: 'error',
    };
    const coerce = {
      progress: (value) => (value === null ? null : Number(value)),
      progressMax: (value) => (value === null ? null : Number(value)),
      values: (value) => JSON.stringify(value ?? {}),
      images: (value) => JSON.stringify(value ?? []),
    };
    const fields = [];
    const params = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      fields.push(`${column} = ?`);
      params.push(coerce[key] ? coerce[key](patch[key]) : patch[key]);
    }
    if (!fields.length) return getRun(id);
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    repo.run(`UPDATE comfy_runs SET ${fields.join(', ')} WHERE id = ?`, params);
    return getRun(id);
  }

  /** 还在排队 / 在跑的 —— 重启后靠它把没盯完的活接回来。 */
  function activeRuns() {
    return repo
      .all(`SELECT ${RUN_COLUMNS} FROM comfy_runs WHERE status IN ('queued','running') ORDER BY created_at ASC`)
      .map(runToObject);
  }

  function removeRun(id) {
    const found = getRun(id);
    if (!found) return false;
    repo.run('DELETE FROM comfy_runs WHERE id = ?', [id]);
    return true;
  }

  /**
   * 把某张图从所有出图记录里摘掉（界面删图时用，素材文件由上层删）。
   * 返回改动过的记录 id；记录本身删不删交给 pruneEmptyRuns 决定
   * （一张图都不剩的那种空壳记录留着只是碍眼，还有图的就得留着）。
   */
  function detachImage(assetId) {
    const id = String(assetId ?? '');
    if (!id) return [];
    const touched = [];
    for (const row of repo.all('SELECT id, images FROM comfy_runs WHERE images LIKE ?', [`%${id}%`])) {
      const images = fromJson(row.images, []);
      if (!Array.isArray(images)) continue;
      const kept = images.filter((entry) => String(entry?.assetId ?? entry?.id ?? entry ?? '') !== id);
      if (kept.length === images.length) continue;
      repo.run('UPDATE comfy_runs SET images = ?, updated_at = ? WHERE id = ?', [JSON.stringify(kept), nowIso(), row.id]);
      touched.push(row.id);
    }
    return touched;
  }

  /** 把"一张图都不剩"的出图记录删掉（就是那条空壳卡片）。返回删了几条。 */
  function pruneEmptyRuns(ids = []) {
    let pruned = 0;
    for (const id of ids) {
      const run = getRun(id);
      if (!run) continue;
      if (Array.isArray(run.images) && run.images.length) continue;
      repo.run('DELETE FROM comfy_runs WHERE id = ?', [id]);
      pruned += 1;
    }
    return pruned;
  }

  function stats() {
    const row = repo.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS active
       FROM comfy_runs`,
    );
    return {
      workflows: repo.get('SELECT COUNT(*) AS n FROM comfy_workflows').n,
      runs: Number(row?.total ?? 0),
      done: Number(row?.done ?? 0),
      failed: Number(row?.failed ?? 0),
      active: Number(row?.active ?? 0),
    };
  }

  // ------------------------------------------------------------------ 角色绑定（v8）

  function listBindings() {
    return repo.all(`SELECT ${BINDING_COLUMNS} FROM comfy_character_bindings ORDER BY updated_at DESC`).map(bindingToObject);
  }

  function getBinding(characterId) {
    if (!characterId) return null;
    return bindingToObject(repo.get(`SELECT ${BINDING_COLUMNS} FROM comfy_character_bindings WHERE character_id = ?`, [characterId]));
  }

  /** upsert：只覆盖传进来的字段，没传的保持原样。 */
  function saveBinding(characterId, patch = {}) {
    const existing = getBinding(characterId);
    const now = nowIso();
    const next = {
      workflowId: patch.workflowId !== undefined ? patch.workflowId : existing?.workflowId ?? null,
      loraText: patch.loraText !== undefined ? patch.loraText : existing?.loraText ?? null,
      expressions: patch.expressions !== undefined ? patch.expressions : existing?.expressions ?? {},
      note: patch.note !== undefined ? patch.note : existing?.note ?? null,
    };
    repo.run(
      `INSERT INTO comfy_character_bindings (character_id, workflow_id, lora_text, expressions, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET
         workflow_id = excluded.workflow_id,
         lora_text = excluded.lora_text,
         expressions = excluded.expressions,
         note = excluded.note,
         updated_at = excluded.updated_at`,
      [characterId, next.workflowId, next.loraText, JSON.stringify(next.expressions ?? {}), next.note, now],
    );
    return getBinding(characterId);
  }

  function removeBinding(characterId) {
    const found = getBinding(characterId);
    if (!found) return false;
    repo.run('DELETE FROM comfy_character_bindings WHERE character_id = ?', [characterId]);
    return true;
  }

  return {
    listWorkflows,
    getWorkflow,
    insertWorkflow,
    updateWorkflow,
    removeWorkflow,
    listLoraSets,
    getLoraSet,
    saveLoraSet,
    removeLoraSet,
    getOutfits,
    saveOutfits,
    removeOutfits,
    listRuns,
    getRun,
    findRunByPromptId,
    findRunByAsset,
    insertRun,
    updateRun,
    activeRuns,
    removeRun,
    detachImage,
    pruneEmptyRuns,
    stats,
    listBindings,
    getBinding,
    saveBinding,
    removeBinding,
  };
}
