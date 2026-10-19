/**
 * 检查 docs/demo-video.html 的成片效果：在多个时间点抓帧，确认
 * 镜头运动、文案层、分镜标签都按预期出现。
 *
 *   node tools/check_demo_video.mjs --out "%TEMP%/demo-check"
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((list, item, i, all) => {
    if (item.startsWith("--")) list.push([item.slice(2), all[i + 1]]);
    return list;
  }, [])
);

const ROOT = path.resolve(process.cwd());
const PAGE = pathToFileURL(path.join(ROOT, "docs", "demo-video.html")).href;
const OUT = path.resolve(args.out || path.join(process.env.TEMP || ".", "demo-check"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(PAGE, { waitUntil: "load" });
  await sleep(800);

  // 暂停，改用 seek 精确定位到每一镜的中段
  await page.evaluate(() => {
    const btn = document.getElementById("btnPlay");
    if (btn && btn.textContent.includes("暂停")) btn.click();
  });

  const cuts = await page.evaluate(() =>
    Array.from(document.querySelectorAll("script")).length ? null : null
  );
  void cuts;

  const timeline = await page.evaluate(() => {
    const total = Number(document.getElementById("timeText").textContent.split(" / ")[1]
      .split(":").reduce((a, b) => a * 60 + Number(b), 0));
    return total;
  });

  // 走一遍整条时间轴，每 6 秒抓一帧
  const frames = [];
  const step = Number(args.step || 6);
  for (let t = 0.5; t < timeline; t += step) {
    await page.evaluate((tt) => {
      const bar = document.getElementById("progress");
      const rect = bar.getBoundingClientRect();
      const total = (() => {
        const [m, s] = document.getElementById("timeText").textContent.split(" / ")[1].split(":");
        return Number(m) * 60 + Number(s);
      })();
      bar.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: rect.left + (tt / total) * rect.width,
        clientY: rect.top + rect.height / 2,
      }));
    }, t);
    await sleep(850);
    const name = `t${String(Math.round(t)).padStart(3, "0")}.png`;
    await page.screenshot({ path: path.join(OUT, name) });
    const info = await page.evaluate(() => ({
      chapter: document.getElementById("chapterTitle").textContent,
      sub: document.getElementById("chapterSub").textContent,
      cue: document.getElementById("cueName").textContent,
      hasImg: Boolean(document.querySelector("#shotBg img")),
      imgSrc: (document.querySelector("#shotBg img") || {}).getAttribute?.("src") || "",
    }));
    frames.push({ t, name, ...info });
    console.log(`  ${name}  ${info.cue}  ${info.hasImg ? "有截图" : "文案页"}  ${info.chapter}`);
  }

  await browser.close();

  const lines = [
    "# 成片自检",
    "",
    `总时长约 ${Math.round(timeline)} 秒，共抓 ${frames.length} 帧。`,
    "",
    "| 时间 | 分镜 | 画面 |",
    "| --- | --- | --- |",
    ...frames.map((f) => `| ${Math.round(f.t)}s | ${f.cue} | ${f.hasImg ? "截图 `" + f.imgSrc + "`" : "纯文案页"} |`),
    "",
    errors.length ? `## 控制台报错\n\n\`\`\`\n${errors.join("\n")}\n\`\`\`` : "## 控制台报错\n\n无。",
    "",
  ];
  await fs.writeFile(path.join(OUT, "report.md"), lines.join("\n"), "utf8");
  console.log(`\n抓帧 ${frames.length} 张 -> ${OUT}`);
  if (errors.length) {
    console.log(`控制台报错 ${errors.length} 条：`);
    errors.slice(0, 8).forEach((e) => console.log("  ! " + e));
  } else {
    console.log("控制台无报错。");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });