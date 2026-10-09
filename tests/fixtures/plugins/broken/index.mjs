// 故意炸：验证单个插件加载失败不会影响主服务启动。
export default function register() {
  throw new Error('这个插件是故意坏的');
}
