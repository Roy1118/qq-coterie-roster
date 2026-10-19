# 演示截图清单

全部截图使用 **虚构演示数据** 生成（见 `tools/make_demo_data.py`），
不含任何真实 QQ 账号、真实群或真实群友信息，可以安全用于视频和文章。

分辨率：1600×900（2 倍图，实际 3200×1800 px）

重新生成：

```bash
python tools/make_demo_data.py --db "$TEMP/roster-demo/roster.db"
python app.py --port 8792 --no-open --data "$TEMP/roster-demo/roster.db"
node tools/make_screenshots.mjs --base http://127.0.0.1:8792 --out docs/screenshots
```

| 文件 | 内容 |
| --- | --- |
| [01-dashboard.png](./01-dashboard.png) | 概览：核心数字 + 跨群排行 |
| [02-dashboard-bottom.png](./02-dashboard-bottom.png) | 概览下半：活跃度分布 / 入群趋势 |
| [03-member-modal.png](./03-member-modal.png) | 群友画像：TA 加入的所有群与群名片 |
| [04-groups.png](./04-groups.png) | 群聊列表：群头像 + 活跃统计 |
| [05-focus.png](./05-focus.png) | 单群透视：跨群名单 + 桥梁成员 |
| [06-focus-bottom.png](./06-focus-bottom.png) | 单群透视下半：跨群分布 / 关系辐射图 |
| [07-overlap.png](./07-overlap.png) | 交叉分析：两群重合 + 共同成员名单 |
| [08-overlap-matrix.png](./08-overlap-matrix.png) | 交叉分析下半：群重合矩阵 |
| [09-members.png](./09-members.png) | 群友检索：按关键词搜索 |
| [10-activity.png](./10-activity.png) | 活跃度：最近活跃 / 潜水 / 新入群 |
| [11-network-force.png](./11-network-force.png) | 群网络：力导向图 |
| [12-network-chord.png](./12-network-chord.png) | 群网络：和弦图 |
| [13-network-heatmap.png](./13-network-heatmap.png) | 群网络：热力图 |
| [14-data.png](./14-data.png) | 登录与数据：导出 / 隐私说明 |
| [15-dark-theme.png](./15-dark-theme.png) | 深色主题下的概览页 |
| [16-mobile.png](./16-mobile.png) | 窄屏下的概览页 |
