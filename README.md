# 消息转图片 (Message to Image)

SillyTavern Gateway 插件：将 AI 回复内容渲染为精美图片发送。支持 ST 正则美化规则导入、自定义 HTML 模板和 CSS。

## 更新日志

### v1.1.1

修复两个会导致"消息延迟后被重复转发多次、且始终无法收到图片"的问题：

- **消息队列重试风暴**：本插件通过让 `filterOutbound` 返回 `null` 来"丢弃原消息、自己异步渲染补发"，
  但网关的消息队列会把"过滤器丢弃了消息"当成"发送失败"，对同一条 AI 回复重试最多 `messageQueue.maxRetries`
  （默认 3）次——每次重试都会重新触发一次完整的渲染+补发流程，导致同一条回复被处理 2~3 遍。
  现已加入幂等标记，保证一条消息只真正触发一次渲染。
- **`file://` 媒体引用在 Telegram/Discord 等平台上无法投递**：渲染出的图片路径此前始终以
  `file://` URI 形式（且有拼接产生 4 个斜杠的畸形 bug）交给各平台适配器。这个格式只有 QQ(OneBot)
  在 NapCat 与网关同机部署时能正确处理；Telegram/Discord 底层库不认识 `file://` scheme，
  会在发送时抛错，插件因此总是回退成发送原始文本——这正是"从未渲染成图片，只收到重复文字"的
  根本原因。现按平台区分：QQ 保留修复后的 `file://` URI，其它平台改用裸本地路径直传。

如果你之前遇到过"消息转图片开启后，AI 回复延迟一会儿、然后原文被发送好几遍、从来没见过图片"，
升级到 v1.1.1 即可修复；无需改动任何配置。

## 功能

- 将 AI 回复文本渲染为 PNG/JPEG 图片发送
- 复用 SillyTavern 正则美化规则（支持导入角色卡 Regex）
- 内置 4 套预设模板（小说卡片、Galgame对话框、终端暗色、极简白底）
- 支持自定义 HTML 模板和 CSS
- Puppeteer 渲染引擎，Browser 复用 + Page 池 + LRU 文件缓存
- 三种渲染模式：auto（长度阈值）/ always（全部）/ tagged（标签内容）
- 并发控制和定时缓存清理

## 安装

### 1. 安装插件

在网关面板「插件管理」中，通过「从 GitHub 安装插件」输入：

```
JOJO666888888/sillytavern-gateway-message-to-image
```

### 2. 安装渲染依赖

插件安装后，需要在其目录下安装 Puppeteer（会自动下载 Chromium）：

```bash
cd plugins/message-to-image
npm install
```

> 如果服务器已有 Chrome/Chromium，可在插件配置中设置 `executablePath` 指向它，跳过 Chromium 下载。

### 3. 启用插件

在插件配置中将 `enabled` 设为 `true`，或发送命令 `/msg2img on`。

## 配置

安装后在插件列表点击「配置」按钮即可打开配置面板。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | false | 是否启用 |
| `renderMode` | enum | "auto" | 渲染模式：auto/always/tagged |
| `renderTag` | string | "maintext" | tagged 模式匹配的标签名 |
| `minLength` | number | 100 | auto 模式最小渲染长度 |
| `templatePreset` | enum | "novel-card" | 模板预设 |
| `baseHtml` | string | "" | 自定义 HTML 模板 |
| `baseCss` | string | "" | 自定义 CSS |
| `fontFamily` | string | "Microsoft YaHei" | 字体族 |
| `imageFormat` | enum | "png" | 图片格式 png/jpeg |
| `imageQuality` | number | 90 | JPEG 质量 |
| `maxWidth` | number | 800 | 图片最大宽度 |
| `maxConcurrent` | number | 2 | 最大并发渲染数 |
| `cacheDays` | number | 7 | 缓存保留天数 |
| `executablePath` | string | "" | Chrome 路径 |
| `applyToPlatforms` | array | [] | 生效平台 |
| `stRules` | array | [] | ST 正则规则 |

## 命令

| 命令 | 说明 |
|------|------|
| `/msg2img on` | 开启 |
| `/msg2img off` | 关闭 |
| `/msg2img status` | 查看状态 |
| `/msg2img test` | 渲染测试 |
| `/msg2img clear-cache` | 清理缓存 |
| `/msg2img import-st <JSON>` | 导入 ST 正则规则 |
| `/msg2img help` | 帮助 |

## 模板变量

模板中可使用以下占位符：

| 占位符 | 说明 |
|--------|------|
| `{{content}}` | 消息内容（已转义） |
| `{{roleName}}` | 角色名 |
| `{{time}}` | 当前时间 |
| `{{messageId}}` | 消息ID |
| `{{fontFamily}}` | 字体族 |

自定义模板必须包含 `.render-root` 类的元素，插件会对该元素截图。

## ST 正则规则导入

将角色卡中的 Regex 规则 JSON 粘贴到命令中：

```
/msg2img import-st [{"find_regex":"<StatusPlaceHolderImpl/>","replace_string":"<div class='status'>...</div>","destination":{"display":true}}]
```

或在配置面板的 `stRules` 字段中填写 JSON 数组。

## 依赖

- SillyTavern Gateway v2+
- Node.js 18+
- Puppeteer（需要 Chrome/Chromium 浏览器）
