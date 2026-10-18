# 小团体花名册

> 找出「既在 A 群、又在 B 群」的群友，并顺便看清你的 QQ 群关系网。
>
> 纯本地运行 · 无第三方依赖 · 不读聊天记录 · 数据不上传

一个面向个人使用的 QQ 群友分析工具：扫码登录 `qun.qq.com`，同步你已加入的群和成员，然后在本地完成跨群重合、活跃度、群关系网络等分析。

## 功能

| 页面 | 能做什么 |
| --- | --- |
| **概览** | 群数、独立群友、跨群群友、7/30 日活跃；跨群最多的人、群重合排行、活跃度分布、入群趋势；四步引导条 + 下一步提示 |
| **群聊** | 群头像、群卡片列表、成员名单、群主/管理员/好友标记、最近活跃、最近入群、单群导出 |
| **单群透视** | 选一个群，查看哪些成员还在其他群、每个人在本群和其他群的昵称/群名片、关联群排行、本群关系辐射图 |
| **交叉分析** | 任选 2 个或多个群，计算交集/并集/Jaccard、仅 A/仅 B、共同成员及其所在的所有群；N×N 群重合矩阵；导出重合名单 |
| **群友** | 按 QQ 号/昵称/群名片搜索；查看 TA 加入的所有群、每个群的昵称和群名片、最早入群、最后发言、同群最多的人 |
| **活跃度** | 最近活跃 / 长期潜水 / 新入群三种视角，可按 7/30/90/180/365 天和单个群筛选 |
| **群网络** | 三种可视化：力导向图（社区着色、聚焦、缩放拖拽）、和弦图（看群间流量）、热力图（两两精确对比） |
| **登录与数据** | 扫码登录、Cookie 登录、同步进度、CSV/JSON 导出、JSON 备份导入、清空数据、表情包墙 |

额外细节：

- 普通群成员身份即可拉取「自己已加入的群」的成员名单，不需要群主/管理员。
- 成员字段包含：QQ 号、昵称、群名片、入群时间、最后发言时间、群等级、是否好友、群主/管理员标记。
- 群头像和群友头像按需抓取并缓存到本地；抓不到时自动生成彩色 SVG 占位图。
- 同步采用「整群替换」，能反映新入群和退群；拉取失败不会清空旧数据。
- 所有统计都在本地 SQLite 上完成，前端不依赖任何 CDN。
- 暖色纸张 + 贴纸风格；13 张抽象表情包已穿插到各个页面，左上角 logo 使用「双击搞小团体」。

## 快速开始

要求：Python 3.10+（Windows / macOS / Linux 均可），**不需要安装任何第三方包**。

```bash
git clone https://github.com/Roy1118/qq-coterie-roster.git
cd qq-coterie-roster
python app.py
```

浏览器会自动打开 <http://127.0.0.1:8765/>。也可以手动访问：

```bash
python app.py --port 9000 --no-open
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--host` | 监听地址，默认 `127.0.0.1`（只允许本机访问） |
| `--port` | 端口，默认 `8765` |
| `--data` | 数据库路径，默认 `data/roster.db` |
| `--no-open` | 不自动打开浏览器 |

也可以作为模块运行：

```bash
python -m qqroster
```

## 使用流程

1. 打开「登录与数据」，点击「生成二维码」，用手机 QQ 扫码。
   - 二维码 3 分钟内有效，失效后重新生成即可。
   - 扫码只用于获取 `qun.qq.com` 的会话 Cookie。
2. 点击「同步群列表」，确认能看到自己加入的群。
3. 点击「同步全部群成员」。群多时需要一些时间（每个群之间会自动间隔，避免触发频率限制）。
4. 去「概览」「交叉分析」「群友」「活跃度」「群网络」查看结果。
5. 需要留档时，在「登录与数据」导出 CSV / JSON；换电脑时导入 JSON 即可。

如果已经有浏览器登录态，也可以在「Cookie 登录（备用）」里粘贴 `document.cookie`。

## 数据来源与原理

### 为什么不用本地 QQ 数据库？

PC 端 NTQQ 的本地数据库是加密的，密钥提取和表结构都跟客户端版本强相关，跨版本很容易失效；而且不同平台的数据库位置也不一样。现有开源工具里，`qq-group-member-insight` 走的是 Android Root + SQLCipher 静态分析，`QunMail` 等走的是 `qun.qq.com` 网页接口。

本项目选择 **`qun.qq.com` 网页接口**：

- 只访问 `ptlogin2.qq.com` 和 `qun.qq.com`；
- 只读取当前登录号**已经加入**的群；
- 只读取成员列表中的公开字段，不读取聊天记录；
- 不需要管理员权限。

### 使用的接口

```text
POST https://qun.qq.com/cgi-bin/qun_mgr/get_group_list
GET  https://qun.qq.com/cgi-bin/qun_info/get_members_info_v1?gc={群号}&friends=1&name=1&bkn={bkn}
```

登录走 `ptlogin2.qq.com` 扫码（`appid=715030901`，`daid=73`），成功后从 Cookie 里的 `skey` / `p_skey` 计算 `bkn`（GTK 5381 算法）。

> 接口属于腾讯网页端内部接口，可能随版本调整。如果某天同步失败，先检查 `qun.qq.com/member.html` 是否还能正常打开。

### 本地数据

- 默认数据库：`data/roster.db`（SQLite，已加入 `.gitignore`）
- 会话 Cookie 存在数据库的 `meta` 表里，不上传
- 导出的 CSV 带 UTF-8 BOM，Excel 可直接打开
- JSON 备份包含群、成员和所有同步字段

## 隐私与合规

- **所有数据只保存在本机**，项目没有任何上报、统计、云同步逻辑。
- 只请求腾讯域名，不请求任何第三方服务。
- 请只在**你自己已加入的群**上使用，遵守 QQ 的用户协议和群规。
- 导出的 CSV / JSON 包含群友 QQ 号，请勿随意分享或公开。
- 本项目与腾讯官方无关。

## 参考项目

做之前调研过一批现成仓库，核心思路和接口细节主要参考了下面这些：

| 项目 | 参考点 |
| --- | --- |
| [788009/qq-group-member-insight](https://github.com/788009/qq-group-member-insight) | 最接近的产品形态：共同群聊 ≥2 的用户、指定群成员还在哪些群、若干群的共同成员；本项目的交叉分析页面受它启发 |
| [gopkg-dev/QunMail](https://github.com/gopkg-dev/QunMail) | 扫码登录协议、`get_members_info_v1` 接口、成员字段含义（`nk/cd/jt/lst/ll/fr/rm`）、`ec=7` 的处理方式 |
| [Goldenglow-1/GET_COMMON_QQ_GROUP_MEMBERS](https://github.com/Goldenglow-1/GET_COMMON_QQ_GROUP_MEMBERS) | Cookie + bkn 拉两个群的共同成员 |
| [Nat-Lab/qgrouop_analyzer](https://github.com/Nat-Lab/qgrouop_analyzer) | 分析命令的设计：共同成员、某人加入的群、群人气排行、潜在好友、关系路径 |
| [caspartse/QQ-Group-Members](https://github.com/caspartse/QQ-Group-Members) | 群成员导出 |
| [Zhaokugua/qq_group_member_extract](https://github.com/Zhaokugua/qq_group_member_extract) | 群被封时从聊天记录导出成员名单的兜底思路 |
| [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ) / [LagrangeDev/Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | NTQQ 协议框架，作为后续「不依赖网页接口」的备选方向 |

本项目的代码是独立实现的，没有直接复制上述项目的代码；协议字段和交互流程参考了公开文档与源码。

## 项目结构

```text
.
├── app.py                  # 启动脚本
├── qqroster/
│   ├── __main__.py         # python -m qqroster
│   ├── auth.py             # 扫码登录、Cookie、bkn
│   ├── client.py           # qun.qq.com 群列表 / 成员接口
│   ├── db.py               # SQLite 存储
│   ├── sync.py             # 后台同步任务与进度
│   ├── analytics.py        # 重合、活跃度、矩阵、网络、单群透视
│   ├── avatars.py          # 群/群友头像抓取、缓存、SVG 兜底
│   ├── export.py           # CSV / JSON 导出
│   ├── server.py           # 本地 HTTP 服务 + JSON API
│   └── static/             # 无依赖前端（HTML/CSS/JS）
│       └── memes/          # 13 张抽象表情包
├── tests/                  # 标准库 unittest
└── data/                   # 运行时生成，已 gitignore
    ├── roster.db           # 群和成员数据
    └── avatars/            # 群头像 / 群友头像缓存
```

## API 一览

本地服务只监听 `127.0.0.1`，并校验 `Origin`，拒绝跨站写请求。

```text
GET  /api/session              登录状态与数据量
GET  /api/groups               群列表 + 活跃统计
GET  /api/groups/{gc}          群详情 + 成员
GET  /api/stats                概览统计
GET  /api/focus?gc=            单群透视：跨群成员、其他群名片、关联群、辐射图
GET  /api/avatar/group/{gc}    群头像（本地缓存，失败时 SVG 兜底）
GET  /api/avatar/user/{uin}    群友头像（本地缓存，失败时 SVG 兜底）
GET  /api/overlap?groups=a,b   多群共同成员
GET  /api/matrix?limit=40      群重合矩阵
GET  /api/members?q=           群友搜索
GET  /api/members/{uin}        群友画像
GET  /api/activity?mode=&days=&gc=
GET  /api/network?min_shared=&max_nodes=
GET  /api/sync                 同步任务进度
POST /api/auth/qr              生成登录二维码
POST /api/auth/qr/poll         轮询扫码状态
POST /api/auth/cookie          粘贴 Cookie 登录
POST /api/sync                 启动同步（full/groups/members/pending）
POST /api/import               导入 JSON 备份
GET  /api/export?kind=...      CSV / JSON 导出
```

## 测试

```bash
python -m unittest discover -s tests -v
```

覆盖：跨群交集/并集/Jaccard、单群透视、成员画像、活跃度三种模式、矩阵与网络、头像缓存/兜底、CSV 导出、JSON 往返导入、成员字段解析、bkn/GTK 计算。

## 已知限制

- 只能看到**当前登录号已加入**的群；看不到没加入的群。
- 依赖 `qun.qq.com` 网页接口，接口变动时可能需要适配。
- 每个群同步之间默认间隔 0.35 秒；群很多时请耐心等待，避免频繁请求。
- 头像来自腾讯 qlogo CDN，首次访问需要联网；失败时会显示彩色 SVG 占位图，不影响数据。
- `last_speak_time` 是「最后发言时间」，不是完整的历史发言统计；每次同步只保留当前快照。
- 不支持读取聊天记录，也不做消息内容分析。
- 群主/管理员字段在 `get_members_info_v1` 里对普通成员可能不完整；群主以响应里的 `owner` 为准。

## 后续可以加的功能

- 本地 NTQQ / Android `group_info.db` 导入（离线、免登录）
- 历史快照对比：谁新加入了群、谁退群了、活跃度变化
- 群友标签、备注、分组
- 小团体/社区发现（基于共同群关系做聚类）
- 定时自动同步与变更提醒
- 打包成单文件 exe / 桌面应用

## License

未指定。使用前请自行确认符合你所在群的规定和当地法律法规。
