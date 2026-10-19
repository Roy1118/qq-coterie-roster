/**
 * 用 Playwright 驱动浏览器，把「小团体花名册」的各个页面截成 PNG。
 *
 * 前置：先跑一个用**演示数据**启动的本地服务（不要连真实账号）：
 *
 *   python tools/make_demo_data.py --db "%TEMP%/roster-demo/roster.db"
 *   python app.py --port 8792 --no-open --data "%TEMP%/roster-demo/roster.db"
 *
 * 然后：
 *
 *   node tools/make_screenshots.mjs --base http://127.0.0.1:8792 --out docs/screenshots
 *
 * 依赖：playwright（本地安装即可；用系统已装的 Edge/Chrome，不额外下载浏览器内核）。
 *   npm i playwright && node tools/make_screenshots.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((list, item, i, all) => {
    if (item.startsWith("--")) list.push([item.slice(2), all[i + 1]]);
    return list;
  }, [])
);

const BASE = (args.base || "http://127.0.0.1:8792").replace(/\/$/, "");
const OUT = path.resolve(args.out || "docs/screenshots");
const W = Number(args.width || 1600);
const H = Number(args.height || 900);
const SCALE = Number(args.scale || 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
    locale: "zh-CN",
  });

  // 演示时不想看到侧边弹层之类的干扰，统一用干净状态
  const shots = [];
  const shot = async (name, note) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push({ name, note, file });
    console.log(`  ✓ ${name}.png  ${note || ""}`);
  };

  const goto = async (hash, wait = 1200) => {
    await page.goto(`${BASE}/#/${hash}`, { waitUntil: "domcontentloaded" });
    await sleep(wait);
  };

    // 页面用的是「窗口滚动」（topbar 是 sticky），所以要滚 window 而不是 #view
    const scrollBottom = async () => {
      await page.evaluate(async () => {
        const step = Math.ceil(window.innerHeight * 0.35);
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 90));
        }
        window.scrollTo(0, document.body.scrollHeight);
      });
      await sleep(900);
    };

  console.log(`base=${BASE} out=${OUT} ${W}x${H}@${SCALE}x`);

  // ---------------------------------------------------------------- 概览
  await goto("dashboard", 2000);
  await shot("01-dashboard", "概览：核心数字 + 跨群排行");

  // 概览下半部分（活跃度分布、入群趋势、功能入口）
    await scrollBottom();
    await shot("02-dashboard-bottom", "概览下半：活跃度分布 / 入群趋势");

  // ---------------------------------------------------------------- 群友画像弹窗
  await goto("dashboard", 2000);
  const memberRow = await page.$('[data-action="open-member"]');
  if (memberRow) {
    await memberRow.click();
    await sleep(1100);
    await shot("03-member-modal", "群友画像：TA 加入的所有群与群名片");
    await page.keyboard.press("Escape");
    await sleep(400);
  }

  // ---------------------------------------------------------------- 群聊列表
  await goto("groups", 1800);
  await shot("04-groups", "群聊列表：群头像 + 活跃统计");

  // ---------------------------------------------------------------- 单群透视
  await goto("focus", 2200);
  await shot("05-focus", "单群透视：跨群名单 + 桥梁成员");
    await scrollBottom();
    await shot("06-focus-bottom", "单群透视下半：跨群分布 / 关系辐射图");

  // ---------------------------------------------------------------- 交叉分析
  await goto("overlap", 3000);
  await shot("07-overlap", "交叉分析：两群重合 + 共同成员名单");
    await scrollBottom();
    await shot("08-overlap-matrix", "交叉分析下半：群重合矩阵");

  // ---------------------------------------------------------------- 群友检索
  await goto("members", 1800);
  const search = await page.$("#memberSearch");
  if (search) {
    const name = await page
      .$eval("#memberTableWrap .name, #memberTableWrap td:nth-child(2)", (el) => el.textContent.trim())
      .catch(() => "");
    if (name) {
      await search.fill(name.slice(0, 2));
      await sleep(1000);
    }
  }
  await shot("09-members", "群友检索：按关键词搜索");

  // ---------------------------------------------------------------- 活跃度
  await goto("activity", 2200);
  await shot("10-activity", "活跃度：最近活跃 / 潜水 / 新入群");

  // ---------------------------------------------------------------- 群网络
  await goto("network", 3000);
  await shot("11-network-force", "群网络：力导向图");

  const chordTab = await page.$('#networkTabs button[data-mode="chord"]');
  if (chordTab) {
    await chordTab.click();
    await sleep(2600);
    await shot("12-network-chord", "群网络：和弦图");
  }

  const heatTab = await page.$('#networkTabs button[data-mode="heatmap"]');
  if (heatTab) {
    await heatTab.click();
    await sleep(2200);
    await shot("13-network-heatmap", "群网络：热力图");
  }

  // ---------------------------------------------------------------- 登录与数据
  await goto("data", 2000);
  await shot("14-data", "登录与数据：导出 / 隐私说明");

  // ---------------------------------------------------------------- 深色主题
  await goto("dashboard", 2000);
  const themeToggle = await page.$("#themeToggle");
  if (themeToggle) {
    await themeToggle.click();
    await sleep(1200);
    await shot("15-dark-theme", "深色主题下的概览页");
    await themeToggle.click();
    await sleep(600);
  }

  // ---------------------------------------------------------------- 手机比例（可选）
  await page.setViewportSize({ width: 480, height: 900 });
    await goto("dashboard", 2200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(400);
    await shot("16-mobile", "窄屏下的概览页");

  await browser.close();

  const lines = [
    "# 演示截图清单",
    "",
    "全部截图使用 **虚构演示数据** 生成（见 `tools/make_demo_data.py`），",
    "不含任何真实 QQ 账号、真实群或真实群友信息，可以安全用于视频和文章。",
    "",
    `分辨率：${W}×${H}（${SCALE} 倍图，实际 ${W * SCALE}×${H * SCALE} px）`,
    "",
    "重新生成：",
    "",
    "```bash",
    'python tools/make_demo_data.py --db "$TEMP/roster-demo/roster.db"',
    'python app.py --port 8792 --no-open --data "$TEMP/roster-demo/roster.db"',
    "node tools/make_screenshots.mjs --base http://127.0.0.1:8792 --out docs/screenshots",
    "```",
    "",
    "| 文件 | 内容 |",
    "| --- | --- |",
    ...shots.map((s) => `| [${s.name}.png](./${s.name}.png) | ${s.note} |`),
    "",
  ];
  await fs.writeFile(path.join(OUT, "README.md"), lines.join("\n"), "utf8");
  console.log(`\n共 ${shots.length} 张，已写入 ${path.join(OUT, "README.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});