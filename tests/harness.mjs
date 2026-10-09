/** 极小的测试骨架：不引第三方，输出保持紧凑（跑测试时省 token）。 */

export function createHarness(title) {
  const cases = [];

  function test(name, fn) {
    cases.push({ name, fn });
  }

  async function run() {
    const failures = [];
    let passed = 0;
    for (const item of cases) {
      try {
        await item.fn();
        passed += 1;
        console.log(`  ok  ${item.name}`);
      } catch (err) {
        failures.push({ name: item.name, err });
        console.log(`FAIL  ${item.name}\n      ${err?.message ?? err}`);
      }
    }
    console.log(`\n${title}: ${passed} 通过 / ${failures.length} 失败（共 ${cases.length}）`);
    return { passed, failed: failures.length, failures };
  }

  return { test, run };
}
