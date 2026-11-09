import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, copyFile, cp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
let preparation;

// npm 不包含 DSH 图标；仅在本机复制到独立辅助应用，不修改 DSH 或 npm 安装目录。
export function prepareNotifier() {
  if (!preparation) preparation = prepare().catch(error => { preparation = undefined; throw error; });
  return preparation;
}

async function prepare() {
  const directory = join(homedir(), 'Library', 'Application Support', 'dsh-reply-notification', '1.2.0');
  const app = join(directory, 'DSH Notifications.app');
  const executable = join(app, 'Contents', 'MacOS', 'terminal-notifier');
  const marker = join(directory, '.ready');
  try {
    await access(marker);
    await access(executable);
    return executable;
  } catch { /* 首次使用或未完成准备时重新准备。 */ }

  const candidates = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/icon.icns',
    join(homedir(), 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'icon.icns'),
  ];
  let icon;
  for (const candidate of candidates) {
    try { await access(candidate); icon = candidate; break; } catch { /* 尝试下一个本地安装位置。 */ }
  }
  if (!icon) throw new Error('找不到 DSH 图标，请将 DeepSeek Harness.app 安装到 /Applications 或 ~/Applications。');

  await mkdir(directory, { recursive: true });
  await cp(fileURLToPath(new URL('./native/Notifier.app', import.meta.url)), app, { recursive: true });
  await mkdir(join(app, 'Contents', 'Resources'), { recursive: true });
  await copyFile(icon, join(app, 'Contents', 'Resources', 'DSH.icns'));
  await chmod(executable, 0o755);
  // 使用系统自带工具重新签名并登记新的本地通知来源，不编译任何代码。
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { timeout: 10000 });
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 10000 });
  await run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app], { timeout: 10000 });
  await writeFile(marker, 'ready\n');
  return executable;
}
