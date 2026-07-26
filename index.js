/**
 * 消息转图片插件 (message-to-image) v1.1
 *
 * 将 AI 回复内容渲染为精美图片发送。
 * - 复用 SillyTavern 正则美化规则
 * - 支持自定义 HTML 模板和 CSS
 * - 内置 4 套预设模板
 * - Puppeteer 渲染引擎，Browser 复用 + Page 池 + LRU 文件缓存
 * - 分级日志系统（INFO/WARN/ERROR/DEBUG）+ 日志查看/导出
 *
 * 依赖网关 R1 (bypassFilters) / R3 (schema 驱动 UI)
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';
import { OutboundMessage } from '../../server/adapters/base-adapter.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

/**
 * 把 renderer.js 产出的 file:// URI 转成对应平台适配器能正确消费的媒体引用。
 *
 * - QQ(OneBot)：CQ 图片段的 file 字段官方支持 file:// URI（要求 NapCat 与网关
 *   同机/同文件系统可见），保留原样。
 * - 其它平台（Telegram/Discord 等）：其底层库（node-telegram-bot-api /
 *   discord.js）不识别 file:// scheme——要么会尝试把整个字符串（含协议头）当
 *   本地路径读盘从而 ENOENT，要么当成远程 URL 交给平台服务端抓取，而平台服务端
 *   根本连不到网关本机/内网地址。两种情况都会在 adapter.send() 内部抛出异常，
 *   于是每次都命中下面 catch 分支的"渲染失败回退原文"，图片永远发不出去。
 *   这里转换为裸本地文件路径，触发这些库"读取本地文件直接上传"的分支，
 *   不依赖网关是否有公网可达地址。
 *
 * @param {string} fileUrl - render() 返回的 file:// URI
 * @param {string} platform - 目标平台
 * @returns {string}
 */
function toMediaRef(fileUrl, platform) {
    if (platform === 'qq') return fileUrl;
    try {
        return fileURLToPath(fileUrl);
    } catch (_) {
        return fileUrl; // 解析失败则原样返回，不影响原有行为
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class MessageToImagePlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'msg2img',
            alias: ['转图'],
            handler: 'handleCommand',
            description: '消息转图片插件配置',
            usage: '/msg2img <on|off|status|test|clear-cache|log|export-log|help>',
        },
    ];

    static listeners = [];

    constructor(options) {
        super(options);
        this._removeFilter = null;
        this._renderer = null;
        this._cleanupTimer = null;
        this._pluginLogger = null; // 自定义日志记录器
    }

    async onLoad() {
        this._ensureDefaults();

        // 初始化自定义日志记录器
        try {
            const { PluginLogger } = await import('./renderer.js');
            this._pluginLogger = new PluginLogger(500);
            this._pluginLogger.info('插件加载开始');
        } catch (err) {
            this.logger.error(`日志记录器初始化失败: ${err.message}`);
        }

        const gateway = this._services.gateway;
        if (gateway && typeof gateway.addOutboundFilter === 'function') {
            this._removeFilter = gateway.addOutboundFilter(
                (msg) => this.filterOutbound(msg),
                { name: 'message-to-image', priority: 20 }
            );
            this._log('info', '出站过滤器已挂载', { priority: 20 });
        } else {
            this._log('warn', '网关不支持出站过滤器');
        }

        // 初始化渲染引擎
        await this._initRenderer();

        // 启动定时缓存清理（每 24 小时）
        this._startCleanupTimer();

        this._log('info', '插件加载完成');
    }

    async onUnload() {
        this._log('info', '插件开始卸载');
        if (this._removeFilter) {
            this._removeFilter();
            this._removeFilter = null;
        }
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
        if (this._renderer) {
            await this._renderer.dispose();
            this._renderer = null;
        }
        this._log('info', '插件已卸载');
    }

    // ==================== 日志辅助 ====================

    _log(level, message, context = null) {
        if (this._pluginLogger) {
            this._pluginLogger[level](message, context);
        }
        // 同时输出到网关 logger
        if (this.logger) {
            const ctxStr = context ? ` ${typeof context === 'string' ? context : JSON.stringify(context)}` : '';
            const fullMsg = `${message}${ctxStr}`;
            if (level === 'error') this.logger.error(fullMsg);
            else if (level === 'warn') this.logger.warn(fullMsg);
            else if (level === 'debug') this.logger.debug(fullMsg);
            else this.logger.info(fullMsg);
        }
    }

    // ==================== 默认配置 ====================

    _ensureDefaults() {
        const defaults = {
            enabled: false,
            renderMode: 'auto',
            renderTag: 'maintext',
            minLength: 100,
            imageFormat: 'png',
            imageQuality: 90,
            maxWidth: 800,
            fontFamily: 'Microsoft YaHei, sans-serif',
            cacheDays: 7,
            maxConcurrent: 2,
            templatePreset: 'novel-card',
            baseHtml: '',
            baseCss: '',
            executablePath: '',
            applyToPlatforms: [],
            stRules: [],
        };
        for (const [key, val] of Object.entries(defaults)) {
            if (this.getConfig(key) === undefined) this.setConfig(key, val);
        }
    }

    // ==================== 渲染引擎初始化 ====================

    async _initRenderer() {
        try {
            const { ImageRenderer } = await import('./renderer.js');

            const cacheDir = path.join(__dirname, 'cache');
            this._renderer = new ImageRenderer({
                cacheDir,
                maxWidth: Number(this.getConfig('maxWidth')) || 800,
                imageFormat: this.getConfig('imageFormat') || 'png',
                imageQuality: Number(this.getConfig('imageQuality')) || 90,
                maxConcurrent: Number(this.getConfig('maxConcurrent')) || 2,
                fontFamily: this.getConfig('fontFamily') || 'Microsoft YaHei, sans-serif',
                executablePath: this.getConfig('executablePath') || '',
                logger: this._pluginLogger,
            });

            await this._renderer.init();
            this._log('info', '渲染引擎已就绪');
        } catch (err) {
            this._log('error', `渲染引擎初始化失败: ${err.message}`);
            this._log('error', '请确保已安装 puppeteer-core 依赖 (在插件目录执行 npm install) 并配置 Chrome 浏览器');
            this._renderer = null;
        }
    }

    // ==================== 核心过滤逻辑 ====================

    /**
     * 出站消息过滤器
     */
    filterOutbound(message) {
        // 基础校验
        if (!message || !message.content) return message;

        // 开关检查
        if (this.getConfig('enabled') !== true) return message;

        // 渲染引擎就绪检查
        if (!this._renderer || !this._renderer.ready) {
            this._log('warn', '渲染引擎未就绪，消息原样放行');
            return message;
        }

        // 平台过滤
        const platforms = this.getConfig('applyToPlatforms') || [];
        if (platforms.length > 0 && !platforms.includes(message.platform)) {
            return message;
        }

        // 递归守卫
        if (message.metadata?._msg2imgProcessed) return message;

        // ⭐ 关键修复：消息队列重试去重守卫。
        //
        // 本方法返回 null 会让 dispatchOutbound() 整体返回 false——但网关的消息队列
        // 把"过滤器丢弃了消息"和"发送失败"视为同一种情况，会按 messageQueue.maxRetries
        // （默认 3 次）对同一条原始消息对象重新调用一遍完整的出站处理流程,包括本过滤器。
        // 如果不加守卫，每次重试都会重新触发一次 _renderAndReplace()——也就是重新渲染
        // 一次、重新补发一次消息，导致同一条 AI 回复被渲染/补发最多 3 次。
        // 表现为：用户先等一会儿（等第一次渲染+发送尝试完成/失败），然后看到同样的内容
        // 被发送了 2~3 次（如果渲染或图片投递失败，补发的是原始文本，看起来就是
        // "延迟后重复转发了几遍一样的正文"）。
        //
        // 消息队列在重试时复用同一个 message 对象引用（不会重新创建），所以可以用
        // metadata 打标记：第一次命中渲染条件时打标记并真正触发异步渲染；
        // 之后（无论是队列重试还是任何其它原因）再次经过这里，只丢弃、不再重复触发。
        if (message.metadata?._msg2imgTriggered) {
            this._log('debug', '消息已触发过渲染（消息队列重试同一条消息），跳过重复渲染');
            return null;
        }

        // 判断是否需要渲染
        const renderMode = this.getConfig('renderMode') || 'auto';
        const { shouldRender, renderContent, isExcerpt } = this._extractRenderContent(message.content, renderMode);

        if (!shouldRender) {
            this._log('debug', '消息不满足渲染条件，原样放行', {
                mode: renderMode,
                contentLength: message.content.length,
                minLength: this.getConfig('minLength'),
            });
            return message;
        }

        this._log('info', '消息命中渲染条件，启动异步渲染', {
            mode: renderMode,
            contentLength: message.content.length,
            renderContentLength: renderContent.length,
            isExcerpt,
        });

        // 打标记必须在触发异步渲染之前、同步完成，才能保证消息队列的重试
        // （哪怕紧跟着立刻发生）也能看到标记。
        message.metadata = message.metadata || {};
        message.metadata._msg2imgTriggered = true;

        // 异步渲染（不阻塞过滤器链）
        this._renderAndReplace(message, renderContent, isExcerpt);

        // 丢弃原消息（渲染完成后补发图片）
        return null;
    }

    /**
     * 根据渲染模式提取要渲染的内容
     */
    _extractRenderContent(content, mode) {
        const minLength = Number(this.getConfig('minLength')) || 100;

        if (mode === 'always') {
            return { shouldRender: content.trim().length > 0, renderContent: content, isExcerpt: false };
        }

        if (mode === 'tagged') {
            const tag = this.getConfig('renderTag') || 'maintext';
            const tagRegex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i');
            const match = content.match(tagRegex);
            if (match) {
                return { shouldRender: true, renderContent: match[1].trim(), isExcerpt: true };
            }
            this._log('debug', 'tagged 模式未找到标签', { tag });
            return { shouldRender: false, renderContent: '', isExcerpt: false };
        }

        // auto 模式
        if (content.length >= minLength) {
            return { shouldRender: true, renderContent: content, isExcerpt: false };
        }
        return { shouldRender: false, renderContent: '', isExcerpt: false };
    }

    /**
     * 异步渲染并补发图片
     */
    async _renderAndReplace(originalMessage, renderContent, isExcerpt) {
        const gateway = this._services.gateway;
        if (!gateway) {
            this._log('error', '网关实例不可用，无法补发');
            return;
        }

        const startTime = Date.now();

        try {
            // 准备模板
            const template = {
                preset: this.getConfig('templatePreset') || 'novel-card',
                html: this.getConfig('baseHtml') || '',
            };
            const css = this.getConfig('baseCss') || '';

            // 准备变量
            const variables = {
                roleName: originalMessage.metadata?.roleName || 'AI',
                time: new Date().toLocaleString('zh-CN', { hour12: false }),
                messageId: originalMessage.metadata?.messageId || '',
            };

            // 应用 ST 正则规则
            const stRules = this.getConfig('stRules') || [];

            this._log('info', '开始渲染', {
                template: template.preset,
                variables,
                stRulesCount: stRules.length,
            });

            // 渲染
            const imageUrl = await this._renderer.render(
                this._escapeHtml(renderContent),
                css,
                template,
                stRules,
                variables
            );

            this._log('info', `渲染成功 (${Date.now() - startTime}ms)`, { imageUrl });

            // 按目标平台转换媒体引用：QQ 保留 file:// URI，其它平台转为裸本地路径
            // （见文件顶部 toMediaRef 说明——这是"图片一直发不出去、只能收到回退文本"
            // 的另一个根因：Telegram/Discord 等适配器不认识 file:// scheme）。
            const mediaRef = toMediaRef(imageUrl, originalMessage.platform);

            // 构造图片消息
            const imgMsg = new OutboundMessage({
                platform: originalMessage.platform,
                chatId: originalMessage.chatId,
                chatType: originalMessage.chatType,
                content: '',
                mediaUrls: [mediaRef],
                replyToId: originalMessage.replyToId || '',
            });
            imgMsg.metadata = { ...originalMessage.metadata, _msg2imgProcessed: true };

            // 如果是截取模式（tagged），先发送剩余文本
            if (isExcerpt) {
                const tag = this.getConfig('renderTag') || 'maintext';
                const tagRegex = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'i');
                const remainingText = originalMessage.content.replace(tagRegex, '').trim();

                if (remainingText) {
                    this._log('info', 'tagged 模式：先发送剩余文本', { remainingLength: remainingText.length });
                    originalMessage.content = remainingText;
                    originalMessage.metadata._msg2imgProcessed = true;
                    // 不再 skipDedup：既然重试风暴已用 _msg2imgTriggered 守卫从根上堵住，
                    // 无需再靠豁免去重来"兜底放行"——保留网关的 15 秒内容去重作为
                    // 最后一道安全网，避免任何遗漏路径导致的重复发送逃过去重。
                    gateway.sendDirect(originalMessage, { bypassFilters: true });
                }
            }

            // 发送图片
            this._log('info', '发送图片消息', { platform: imgMsg.platform, chatId: imgMsg.chatId, mediaRef });
            await gateway.sendDirect(imgMsg, { bypassFilters: true });
            this._log('info', '图片消息已发送');
        } catch (err) {
            this._log('error', `渲染失败，回退为原文本: ${err.message}`, {
                stack: err.stack?.split('\n').slice(0, 3).join(' | '),
            });
            // 渲染失败：补发原始消息
            const fallbackMsg = new OutboundMessage({
                platform: originalMessage.platform,
                chatId: originalMessage.chatId,
                chatType: originalMessage.chatType,
                content: originalMessage.content,
                replyToId: originalMessage.replyToId || '',
            });
            fallbackMsg.metadata = { ...originalMessage.metadata, _msg2imgProcessed: true };
            try {
                await gateway.sendDirect(fallbackMsg, { bypassFilters: true });
                this._log('info', '原文本已补发');
            } catch (sendErr) {
                this._log('error', `补发原文本也失败: ${sendErr.message}`);
            }
        }
    }

    /**
     * HTML 转义（防止注入）
     */
    _escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ==================== 定时缓存清理 ====================

    _startCleanupTimer() {
        const cacheDays = Number(this.getConfig('cacheDays')) || 7;
        this._cleanupTimer = setInterval(() => {
            if (this._renderer) {
                this._renderer.cleanupCache(cacheDays).catch(() => {});
            }
        }, 24 * 60 * 60 * 1000);
        this._log('info', '定时缓存清理已启动', { cacheDays });
    }

    // ==================== ST 正则规则导入 ====================

    /**
     * 从 SillyTavern 正则规则导入
     */
    importFromST(input) {
        let rules = input;

        if (typeof input === 'string') {
            try {
                rules = JSON.parse(input);
            } catch {
                return { imported: 0, skipped: 0, error: 'JSON 解析失败' };
            }
        }

        if (!Array.isArray(rules)) {
            rules = [rules];
        }

        const existingRules = this.getConfig('stRules') || [];
        const existingPatterns = new Set(existingRules.map(r => r.findRegex || r.pattern));
        let imported = 0;
        let skipped = 0;

        for (const raw of rules) {
            const normalized = this._normalizeSTRule(raw);

            if (normalized.destination && normalized.destination.display !== true) {
                skipped++;
                continue;
            }

            const pattern = normalized.findRegex || normalized.pattern;
            if (!pattern || existingPatterns.has(pattern)) {
                skipped++;
                continue;
            }

            existingPatterns.add(pattern);
            existingRules.push(normalized);
            imported++;
        }

        this.setConfig('stRules', existingRules);
        this._log('info', `ST 正则规则导入完成`, { imported, skipped });
        return { imported, skipped };
    }

    _normalizeSTRule(raw) {
        return {
            name: raw.script_name || raw.scriptName || raw.name || '未命名',
            enabled: raw.enabled !== false,
            findRegex: raw.find_regex || raw.findRegex || raw.pattern || '',
            replaceString: raw.replace_string ?? raw.replaceString ?? raw.replacement ?? '',
            trimStrings: raw.trim_strings || raw.trimStrings || [],
            source: raw.source || null,
            destination: raw.destination || null,
        };
    }

    // ==================== 命令处理 ====================

    async handleCommand(ctx) {
        const sub = (ctx.args[0] || 'status').toLowerCase();
        switch (sub) {
            case 'on':
                this.setConfig('enabled', true);
                this._log('info', '插件已通过命令启用');
                return ctx.reply('✅ 消息转图片已开启');
            case 'off':
                this.setConfig('enabled', false);
                this._log('info', '插件已通过命令关闭');
                return ctx.reply('❌ 消息转图片已关闭');
            case 'status':
                return this._cmdStatus(ctx);
            case 'test':
                return this._cmdTest(ctx);
            case 'clear-cache':
            case '清理':
                return this._cmdClearCache(ctx);
            case 'import-st':
            case '导入':
                return this._cmdImportST(ctx);
            case 'log':
            case '日志':
                return this._cmdLog(ctx);
            case 'export-log':
            case '导出日志':
                return this._cmdExportLog(ctx);
            case 'clear-log':
            case '清空日志':
                if (this._pluginLogger) {
                    this._pluginLogger.clear();
                    return ctx.reply('✅ 日志已清空');
                }
                return ctx.reply('日志记录器未初始化');
            case 'help':
            case '帮助':
            default:
                return this._cmdHelp(ctx);
        }
    }

    async _cmdStatus(ctx) {
        const rendererReady = this._renderer?.ready || false;
        const cacheSize = this._renderer ? await this._renderer.getCacheSize() : 0;
        const cacheMB = (cacheSize / 1024 / 1024).toFixed(2);
        const cacheCount = this._renderer ? await this._renderer.getCacheFileCount() : 0;
        const platforms = this.getConfig('applyToPlatforms') || [];
        const stats = this._renderer?.getStats() || {};
        const logCount = this._pluginLogger?.entries.length || 0;

        return ctx.reply([
            '🖼️ 消息转图片 - 状态',
            `  启用: ${this.getConfig('enabled') === true ? '✅' : '❌'}`,
            `  渲染引擎: ${rendererReady ? '✅ 就绪' : '❌ 未就绪'}`,
            `  渲染模式: ${this.getConfig('renderMode') || 'auto'}`,
            `  渲染标签: <${this.getConfig('renderTag') || 'maintext'}>`,
            `  最小长度: ${this.getConfig('minLength') ?? 100}`,
            `  图片格式: ${this.getConfig('imageFormat') || 'png'} (质量: ${this.getConfig('imageQuality') ?? 90})`,
            `  最大宽度: ${this.getConfig('maxWidth') ?? 800}px`,
            `  模板预设: ${this.getConfig('templatePreset') || 'novel-card'}`,
            `  ST 规则: ${this.getConfig('stRules')?.length || 0} 条`,
            `  缓存: ${cacheCount} 个文件, ${cacheMB} MB`,
            `  生效平台: ${platforms.length ? platforms.join(', ') : '全部'}`,
            '',
            '📊 统计:',
            `  总渲染次数: ${stats.totalRenders || 0}`,
            `  缓存命中: ${stats.cacheHits || 0}, 未命中: ${stats.cacheMisses || 0}`,
            `  失败次数: ${stats.failures || 0}`,
            `  平均耗时: ${stats.avgRenderTime || 0}ms`,
            `  队列长度: ${stats.queueLength || 0}`,
            `  日志条数: ${logCount}`,
        ].join('\n'));
    }

    async _cmdTest(ctx) {
        if (!this._renderer?.ready) {
            return ctx.reply('❌ 渲染引擎未就绪，无法测试');
        }

        const sampleText = '「唔……徒儿早啊。」\n\n声音里带着一丝慵懒的鼻音，从神念中传来。阳光透过窗棂洒在她的发梢上，映出一圈淡淡的光晕。\n\n她似乎还没完全醒来，眼睫微微颤动。';

        try {
            const template = {
                preset: this.getConfig('templatePreset') || 'novel-card',
                html: this.getConfig('baseHtml') || '',
            };
            const css = this.getConfig('baseCss') || '';
            const stRules = this.getConfig('stRules') || [];

            this._log('info', '执行渲染测试命令');
            const imageUrl = await this._renderer.render(
                this._escapeHtml(sampleText),
                css,
                template,
                stRules,
                { roleName: '师尊', time: new Date().toLocaleString('zh-CN', { hour12: false }), messageId: 'test' }
            );

            this._log('info', '测试渲染成功', { imageUrl });
            const mediaRef = toMediaRef(imageUrl, ctx.platform);
            await ctx.reply('🧪 渲染测试结果：', { mediaUrls: [mediaRef] });
        } catch (err) {
            this._log('error', `测试渲染失败: ${err.message}`);
            return ctx.reply(`❌ 渲染失败: ${err.message}`);
        }
    }

    async _cmdClearCache(ctx) {
        if (!this._renderer) return ctx.reply('渲染引擎未初始化');

        const cacheDir = this._renderer.cacheDir;
        try {
            const files = await fs.readdir(cacheDir);
            for (const file of files) {
                await fs.unlink(path.join(cacheDir, file));
            }
            this._log('info', `缓存已清理`, { files: files.length });
            return ctx.reply(`✅ 已清理 ${files.length} 个缓存文件`);
        } catch (err) {
            return ctx.reply(`清理失败: ${err.message}`);
        }
    }

    async _cmdImportST(ctx) {
        const jsonText = ctx.args.slice(1).join(' ');
        if (!jsonText) {
            return ctx.reply([
                '📋 ST 正则规则导入',
                '',
                '用法: /msg2img import-st <JSON>',
                '',
                '将角色卡的 Regex 规则 JSON 粘贴在命令后面。',
                '仅导入 destination.display=true 的规则。',
            ].join('\n'));
        }

        const result = this.importFromST(jsonText);
        if (result.error) {
            return ctx.reply(`❌ 导入失败: ${result.error}`);
        }
        return ctx.reply(`✅ 导入完成: ${result.imported} 条导入, ${result.skipped} 条跳过`);
    }

    async _cmdLog(ctx) {
        if (!this._pluginLogger) {
            return ctx.reply('日志记录器未初始化');
        }

        const count = parseInt(ctx.args[1]) || 20;
        const level = ctx.args[2]?.toUpperCase();
        const validLevels = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
        const filterLevel = validLevels.includes(level) ? level : null;

        const logs = this._pluginLogger.recent(count, filterLevel);
        if (logs.length === 0) {
            return ctx.reply('暂无日志记录');
        }

        const text = logs.map(e => {
            const ctx_str = e.context ? ` | ${e.context}` : '';
            return `[${e.timestamp}] [${e.level}] ${e.message}${ctx_str}`;
        }).join('\n');

        // 截断超长文本
        const truncated = text.length > 3500
            ? text.slice(0, 3500) + `\n... (已截断，共 ${logs.length} 条)`
            : text;

        return ctx.reply(`📜 最近 ${logs.length} 条日志${filterLevel ? ` (${filterLevel})` : ''}:\n\n${truncated}`);
    }

    async _cmdExportLog(ctx) {
        if (!this._pluginLogger) {
            return ctx.reply('日志记录器未初始化');
        }

        const text = this._pluginLogger.exportText();
        if (!text) {
            return ctx.reply('暂无日志记录');
        }

        // 写入文件
        const exportPath = path.join(__dirname, `log-export-${Date.now()}.txt`);
        try {
            await fs.writeFile(exportPath, text, 'utf-8');
            this._log('info', '日志已导出', { path: exportPath });
            return ctx.reply([
                `✅ 日志已导出到: ${exportPath}`,
                `   共 ${this._pluginLogger.entries.length} 条记录`,
            ].join('\n'));
        } catch (err) {
            return ctx.reply(`导出失败: ${err.message}`);
        }
    }

    async _cmdHelp(ctx) {
        return ctx.reply([
            '🖼️ 消息转图片插件 v1.1',
            '',
            '命令:',
            '  /msg2img on - 开启',
            '  /msg2img off - 关闭',
            '  /msg2img status - 查看状态和统计',
            '  /msg2img test - 渲染测试',
            '  /msg2img clear-cache - 清理缓存',
            '  /msg2img log [数量] [级别] - 查看日志',
            '  /msg2img export-log - 导出日志到文件',
            '  /msg2img clear-log - 清空日志',
            '  /msg2img import-st <JSON> - 导入 ST 正则规则',
            '  /msg2img help - 显示此帮助',
            '',
            '日志级别: INFO / WARN / ERROR / DEBUG',
            '示例: /msg2img log 50 ERROR',
            '',
            '配置可通过面板「插件管理」中的配置按钮修改',
            '渲染模式: auto(长度阈值) / always(全部) / tagged(标签内)',
        ].join('\n'));
    }
}
