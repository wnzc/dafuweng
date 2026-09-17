# 大富翁 · 地产小镇

装饰艺术（Art Deco）风格的网页版大富翁，手机竖屏优先，1 人对战 3 个 AI。
纯前端、零依赖、零构建：**双击 `index.html` 就能玩**。

线上：<https://wnzc.github.io/dafuweng/>（push 到 `main` 自动发布）

## 运行

```bash
# 直接打开
open index.html

# 或者起个静态服务（推荐，localStorage 存档在 file:// 下可能被浏览器禁用）
python3 -m http.server 8765
# → http://127.0.0.1:8765
```

## 玩法与功能

| 模块 | 说明 |
|---|---|
| 掷骰 | 一枚骰子，按点数前进 |
| 移动 | 逐格动画：每格 300ms 一跳、跳完停顿，看清一步一步前进；经过起点领 ¥2,000 |
| 买地 | 落格无人认领可买下；放弃则转入拍卖 |
| 拍卖 | 加价竞拍，AI 按估值上限出价，人类可随时放弃 |
| 租金 | 空地租金 / 满组双倍 / 1–4 栋房屋 / 酒店阶梯 |
| 公用事业 | 持有 1 家骰子 ×80，2 家 ×200；可升级，每级倍率 +50 |
| 车站 | 持有 1–4 座，租金 ¥250→¥2,000；可升级，每级 +¥300 |
| 建造/升级 | 再次停在**自己已买下**的地产/车站/水厂/电厂时，弹窗询问是否升级；最高满级 |
| 抵押 | 抵押得半价，赎回付 110%，有房不可抵押 |
| 监狱 | 缴纳保释金 ¥500 / 出狱许可证 / 掷骰求 6，三回合强制保释 |
| 税收 | 所得税为现金 10%（下限 ¥1,000），罚款进入免费停车场奖池 |
| 卡牌 | 机会 / 命运各 12 张：位移、收付、按房屋收费、全体互付、入狱、出狱证 |
| 破产 | 现金不足时拆房 / 抵押筹款，仍不足则破产，产业转给债主或银行 |
| AI | 买地看现金与满组价值、会建房、会赎回、会参与竞拍 |
| 存档 | 每个回合开始时自动存档，下次可「继续上次对局」 |
| 音效 | WebAudio 现场合成（骰子 / 收钱 / 付钱 / 盖章 / 铁门 / 建房 / 胜利），可静音 |
| 反馈 | 震动、浮动金额、盖章特效、战报流水 |
| 无障碍 | 焦点环、aria-label、`prefers-reduced-motion`、`prefers-contrast` |

## 布局

- **手机竖屏**：顶栏（品牌 + 音效/菜单）→ 玩家条（横向滚动，自动滚到当前玩家）→ 棋盘（1:1，`--u = 棋盘边长/100`，格内所有尺寸按 `--u` 缩放）→ 战报面板（吃掉剩余高度）→ 操作坞（资产 / 掷骰子 / 规则）。
- **横屏矮屏**（`orientation: landscape and max-height: 560px`）：棋盘在左，信息与操作在右。
- **桌面 ≥900px**：容器居中，弹层变为居中对话框。
- 棋盘边长由 `ResizeObserver` + 视口高度预算计算，360×640 到 1280×900 都不横滚、不裁切。

## 目录

```
index.html        结构与 SVG 图标 sprite
styles.css        设计系统（令牌 → 组件 → 响应式 → 无障碍）
js/data.js        24 格棋盘、卡组、分组、7×7 环坐标
js/audio.js       WebAudio 合成音效
js/engine.js      规则引擎：异步回合循环 + 全部规则 + AI + 存档
js/ui.js          渲染、骰子动画、弹层（地契 / 拍卖 / 筹款 / 资产 / 战报 / 结算）
js/main.js        启动与偏好设置
docs/…            设计规格
tools/            开发期验证脚本（可选，不影响游戏运行）
tools/make-cert.sh  生成本地调试用自签 HTTPS 证书（证书不入库）
```

## 设计说明

- **方向**：3D 手游风（Monopoly GO 那类）。深蓝天幕 `#1B4E96 → #5FA8E4` + 琥珀棋盘框 `#FFD98A → #E09A33`，高饱和主色金 `#FFC93C` / 粉 `#FF5C8A` / 绿 `#4CD964` / 蓝 `#35C1F0` / 紫 `#A96BFF`。
- **立体语言**：每个可点元素都是「亮面 + 内高光 + 深色立体边 + 投影」的四层结构，按下时下沉到立体边上（`translateY(5px)`）。棋盘用 `padding-box / border-box` 双层渐变做出木框厚度。
- **字体**：圆体（`Yuanti SC` / `ui-rounded`），重量 800–900；关键标题与浮动金额带深色描边（多层 `text-shadow`），这是手游 UI 的典型质感。
- **签名元素**：金币与印章。收钱时一枚金币从格子沿抛物线飞进对应玩家卡片；买地时金色印章弹跳盖下并撒彩带；付租金/缴税时整个界面轻微震屏。
- **动效**（`prefers-reduced-motion` 下全部关闭）：棋盘弹入 + 24 格逐个弹出 · 骰子翻滚落定 · 金币飞入 · 震屏 · 按钮下沉回弹 · 弹层弹簧滑入 · 地契卡 3D 翻转 · 太阳与云朵环境动画。
- **前进节奏**：掷骰落定后停 200ms → 棋子逐格移动，每格 **300ms**（跳跃 260ms + 位移 220ms + 落格小弹跳），一格一跳、跳完再走下一格。
  在「菜单 → 设置 → 动画速度」里可调：慢 464ms / 标准 302ms / 快 178ms 每格。

## 主题文件

- `themes/theme-candy.css` 是上一版「糖果可爱风」的完整样式备份，替换 `styles.css` 即可切回。

## 开发期验证（可选）

### 手机上跑真机（震动反馈需要 HTTPS）

`navigator.vibrate` 只在安全上下文开放，所以局域网调试必须走 HTTPS：

```bash
bash tools/make-cert.sh       # 生成自签证书（不入库；换网络后重跑，脚本会重新探测本机 IP）
node tools/serve-https.mjs    # → https://<本机IP>:8766
```

首次需在手机上安装并信任 `.cert/cert.pem`（iOS：设置 → 通用 → 关于本机 → 证书信任设置），换新证书后要重做一次。

### 无人值守驱动 / 截图

```bash
# 需要本地 Chrome + Node 22
python3 -m http.server 8765 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
  --remote-debugging-port=9333 --user-data-dir=/tmp/dc-chrome \
  "http://127.0.0.1:8765/index.html" &

node tools/drive.mjs eval "DC.game.engine.state.round"   # 读状态
node tools/drive.mjs shot out.png 390 844                # 截图
node tools/drive.mjs watch 2000                          # 收集控制台异常
```

`tools/ocr.swift` 是 macOS Vision OCR 小工具，用于在没有视觉模型时读屏幕文字（编译产物 `tools/bin/` 不入库）：

```bash
swiftc -module-cache-path ./tools/.mcache -o tools/bin/ocr tools/ocr.swift
./tools/bin/ocr out.png 0.3
```

## 许可

[MIT](LICENSE)
