/**
 * 把 tests/fixtures/mock-comfy-server.mjs 当成一个能"被托管启动"的独立进程跑。
 * 用法：node mock-comfy-cli.mjs <端口> [延迟毫秒]
 * 托管测试里它扮演"整合包里的 ComfyUI"：酒馆 spawn 它、等它 /system_stats 回话。
 */
import { createMockComfy } from './mock-comfy-server.mjs';

const port = Number(process.argv[2] ?? 0);
const latencyMs = Number(process.argv[3] ?? 300);

const mock = createMockComfy({ latencyMs });
await new Promise((resolve) => mock.server.listen(port, '127.0.0.1', resolve));
console.log(`mock-comfy listening on ${mock.url}`);
