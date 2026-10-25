// 测试种子数据：公开包不含 data/（真实角色卡带个人信息，不进仓库），
// 开发机上 data/ 齐全就直接用；干净环境（刚 clone / CI）用 test/fixtures/
// 的通用演示种子补位——只补缺失的文件，绝不覆盖已有数据。
//
// 注意调用时机：必须在「读 data/ 之前」。各测试文件在设置 MOYING_DATA_DIR
// 之后、从 data/ 拷贝种子之前调用本函数。
//
// 并发安全：node --test 会多个进程同时跑各个测试文件，干净环境下它们会同时
// 发现「data/ 缺文件」并一起补位。直接 copyFileSync 到目标路径，两个进程
// 交叉写同一个文件会产生半个 JSON（实测：6 个测试随机挂）。所以一律
// 「先写临时文件、再 rename」——rename 在同目录下是原子的，读者永远看到
// 完整文件，不会看到写一半的内容。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

export function ensureSeedData() {
  const dataDir = path.join(ROOT, 'data');
  const fixtures = path.join(ROOT, 'test', 'fixtures');
  let made = 0;
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch { return 0; }
  let files = [];
  try { files = fs.readdirSync(fixtures); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue; // README.md 之类的说明文件不进 data/
    const dst = path.join(dataDir, f);
    if (fs.existsSync(dst)) continue;
    try {
      // 原子落位：临时文件 + rename（同文件系统内原子）
      const tmp = `${dst}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
      fs.copyFileSync(path.join(fixtures, f), tmp);
      try {
        fs.renameSync(tmp, dst);
      } catch {
        // 竞态对手已经先落位了：丢掉自己的临时文件即可（他的也是完整文件）
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
      made += 1;
    } catch { /* 只读环境：算了，让测试自己报缺文件 */ }
  }
  return made;
}
