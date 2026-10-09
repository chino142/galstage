/**
 * 适配器目录与一键预设。
 *
 * 两个概念要分清：
 *   - kind    这个提供方是干什么的（chat / embedding / image / speech / transcription）
 *   - adapter 怎么跟它说话（openai / azure / anthropic / gemini / text）
 *
 * 绝大多数服务商都说 OpenAI 的 chat-completions 方言，唯一容易填错的是 base URL，
 * 所以下面给了一份预设表，选中即填好 kind + base URL + 一个起始模型。
 */

export const ADAPTERS = [
  {
    id: 'openai',
    title: 'OpenAI 兼容',
    kinds: ['chat', 'embedding'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    // 模型**不预填**：写死一个型号过一阵就老了，填错还会以为"这家坏了"。
    // 新建时留空，保存后列表里有「列模型」，直接列出这家真正提供的模型名。
    defaultModel: '',
    note: 'OpenAI / DeepSeek / OpenRouter / 各类中转网关，以及本地 llama.cpp、Ollama、LM Studio。模型名照你的服务商文档填；保存后点「列模型」能直接列出来。',
  },
  {
    id: 'azure',
    title: 'Azure OpenAI',
    kinds: ['chat', 'embedding'],
    defaultBaseUrl: 'https://your-resource.openai.azure.com',
    defaultModel: '',
    note: '模型字段填部署名（deployment），地址填资源终结点；密钥走 api-key 头。',
  },
  {
    id: 'anthropic',
    title: 'Anthropic',
    kinds: ['chat'],
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    note: '原生 /v1/messages 流式接口。Anthropic 没有嵌入接口，向量要用别家。',
  },
  {
    id: 'gemini',
    title: 'Google Gemini',
    kinds: ['chat', 'embedding'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    note: '走 streamGenerateContent。',
  },
  {
    id: 'text',
    title: '文本补全（/v1/completions）',
    kinds: ['chat'],
    defaultBaseUrl: 'http://127.0.0.1:5001/v1',
    defaultModel: '',
    note: '给不提供 chat 接口的本地模型用：没有角色区分，提示词会被拼成一整段。',
  },
  {
    id: 'vertex',
    title: 'Google Vertex AI',
    kinds: ['chat', 'embedding'],
    defaultBaseUrl: '',
    defaultModel: 'gemini-2.5-pro',
    note: '服务账号或 express API key 两种模式；同一个适配器也能调 Model Garden 上的 Claude。',
  },
];

export const DEFAULT_AZURE_API_VERSION = '2024-10-21';
export const ANTHROPIC_VERSION = '2023-06-01';

export function adapterById(id) {
  return ADAPTERS.find((item) => item.id === id) ?? null;
}

/** kind × adapter 是否配得上。 */
export function adapterSupports(adapterId, kind) {
  const adapter = adapterById(adapterId);
  return Boolean(adapter && adapter.kinds.includes(kind));
}

export const PRESETS = [
  // 说明：预填的模型名只当"顺手填一个"，**不预填快过时的**。
  // 拿不准的（OpenAI / Azure / 中转）一律留空，让「列模型」去问这家到底有什么。
  // 留下名字的都是本仓库当下确实在用、或能对上的：DeepSeek 官方接口那个、
  // Anthropic 的 claude-sonnet-4、Gemini 3 / Claude 4 这些。
  { id: 'openai', label: 'OpenAI', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.openai.com/v1', model: '', note: '模型名照账号文档填；保存后上面列表里点「列模型」能列出来' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic', kind: 'chat', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514' },
  { id: 'gemini', label: 'Google Gemini', adapter: 'gemini', kind: 'chat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3-pro-preview', note: '模型名各家开放的不一样，填不上就保存后用「列模型」列一下' },
  { id: 'deepseek', label: 'DeepSeek 深度求索', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
  { id: 'moonshot', label: '月之暗面 Kimi', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview' },
  { id: 'zhipu', label: '智谱 GLM', adapter: 'openai', kind: 'chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B' },
  { id: 'groq', label: 'Groq', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'xai', label: 'xAI Grok', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' },
  { id: 'openrouter', label: 'OpenRouter', adapter: 'openai', kind: 'chat', baseUrl: 'https://openrouter.ai/api/v1', model: '', note: 'OpenRouter 的模型名带前缀（厂家/型号），用「列模型」列出来挑最省事' },
  { id: 'together', label: 'Together AI', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'mistral', label: 'Mistral', adapter: 'openai', kind: 'chat', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
  { id: 'ollama', label: 'Ollama（本地）', adapter: 'openai', kind: 'chat', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', note: '先跑 ollama serve' },
  { id: 'lmstudio', label: 'LM Studio（本地）', adapter: 'openai', kind: 'chat', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' },
  { id: 'llamacpp', label: 'llama.cpp server（本地）', adapter: 'openai', kind: 'chat', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-model' },
  { id: 'koboldcpp', label: 'KoboldCpp（本地）', adapter: 'openai', kind: 'chat', baseUrl: 'http://127.0.0.1:5001/v1', model: 'koboldcpp' },
  { id: 'vllm', label: 'vLLM（本地）', adapter: 'openai', kind: 'chat', baseUrl: 'http://127.0.0.1:8000/v1', model: 'local-model' },
  { id: 'local-text', label: '本地文本补全（/v1/completions）', adapter: 'text', kind: 'chat', baseUrl: 'http://127.0.0.1:5001/v1', model: '', note: '给不支持 chat 接口的本地模型' },
  { id: 'azure', label: 'Azure OpenAI', adapter: 'azure', kind: 'chat', baseUrl: 'https://your-resource.openai.azure.com', model: '', note: '模型填部署名，地址填资源终结点' },
  { id: 'vertex-gemini', label: 'Vertex AI（Gemini）', adapter: 'vertex', kind: 'chat', baseUrl: '', model: 'gemini-2.5-pro', note: '高级里选 express（填 API key）或服务账号（填 project / location / SA JSON）' },
  { id: 'vertex-claude', label: 'Vertex AI（Claude）', adapter: 'vertex', kind: 'chat', baseUrl: '', model: 'claude-sonnet-4@20250514', note: 'Model Garden 上的 Claude，走 streamRawPredict' },
  { id: 'relay', label: '通用中转 / 公益站', adapter: 'openai', kind: 'chat', baseUrl: 'https://你的中转站/v1', model: '', note: '填地址和 key 就行；模型名用「列模型」列出来挑（中转站的型号名各家不同）；鉴权方式对不上时去高级里改' },
  { id: 'claude-cli', label: 'Claude（CLI 本地代理）', adapter: 'anthropic', kind: 'chat', baseUrl: 'http://127.0.0.1:3456/v1', model: 'claude-sonnet-4-20250514', note: '先用订阅登录 CLI，再由转换代理开端口；高级里填启动命令，酒馆会自己把它拉起来' },
  { id: 'gemini-cli', label: 'Gemini（CLI 本地代理）', adapter: 'openai', kind: 'chat', baseUrl: 'http://127.0.0.1:3210/v1', model: 'gemini-3-pro-preview', note: '同上：填本地代理的端口与启动命令' },
  { id: 'openai-embed', label: 'OpenAI 嵌入', adapter: 'openai', kind: 'embedding', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
  { id: 'gemini-embed', label: 'Gemini 嵌入', adapter: 'gemini', kind: 'embedding', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'text-embedding-004' },
  { id: 'siliconflow-embed', label: '硅基流动嵌入', adapter: 'openai', kind: 'embedding', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3' },
];
