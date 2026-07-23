/**
 * 消息转图片插件 (message-to-image)
 *
 * 将 AI 回复内容渲染为精美图片发送。
 * - 复用 SillyTavern 正则美化规则
 * - 支持自定义 HTML 模板和 CSS
 * - 内置 4 套预设模板
 * - Puppeteer 渲染，Browser 复用 + Page 池 + LRU 文件缓存
 *
 * 依赖网关 R1 (bypassFilters) / R3 (schema 驱动 UI)
 */

import { GatewayPlugin } from '../../server/plugin-sdk.js';
import { OutboundMessage } from '../../server/adapters/base-adapter.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class MessageToImagePlugin extends GatewayPlugin {
    static commands = [
        {
            name: 'msg2img',
            alias: ['转图'],
            handler: 'handleCommand',
            description: '消息转图片插件配置',
            usage: '/msg2img <on|off|status|test|clear-cache>',
        },
    ];

    static listeners = [];

    constructor(options) {
        super(options);
        this._removeFilter = null;
        this._renderer = null;
        this._cleanupTimer = null;
    }

    async onLoad() {
        this._ensureDefaults();

        const gateway = this._services.gateway;
        if (gateway && typeof gateway.addOutboundFilter === 'function') {
            // priority=20: 在 regex-filter(10) 之后执行
            this._removeFilter = gateway.addOutboundFilter(
                (msg) => this.filterOutbound(msg),
                { name: 'message-to-image', priority: 20 }
            );
            this.logger.info('消息转图片过滤器已挂载 (priority=20)');
        } else {
            this.logger.warn('网关不支持出站过滤器');
        }

        // 初始化渲染引擎
        await this._initRenderer();

        // 启动定时缓存清理（每 24 小时）
        this._startCleanupTimer();
    }

    async onUnload() {
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
    }

    // ==================== 默认配置 ====================

    _ensureDefaults() {
        const defaults = {
            enabled: false,           // 默认关闭，用户确认 Chrome 可用后手动开启
            renderMode: 'auto',       // auto | always | tagged
            renderTag: 'maintext',    // tagged 模式下匹配的标签名
            minLength: 100,           // auto 模式下的最小渲染长度
            imageFormat: 'png',
            imageQuality: 90,
            maxWidth: 800,
            fontFamily: 'Microsoft YaHei, sans-serif',
            cacheDays: 7,
            maxConcurrent: 2,
            templatePreset: 'novel-card',
            baseHtml: '',
            baseCss: '',
            executablePath: '',       // Chrome 可执行文件路径（留空=用 puppeteer 自带）
            applyToPlatforms: [],
            stRules: [],              // ST 正则规则数组
        };
        for (const [key, val] of Object.entries(defaults)) {
            if (this.getConfig(key) === undefined) this.setConfig(key, val);
        }
    }

    // ==================== 渲染引擎初始化 ====================

    async _initRenderer() {
        try {
            // 动态导入，避免 puppeteer 未安装时整个插件崩溃
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
            });

            await this._renderer.init();
            this.logger.info('Puppeteer 渲染引擎已就绪');
        } catch (err) {
            this.logger.error(`渲染引擎初始化失败: ${err.message}`);
            this.logger.error('请确保已安装 puppeteer 依赖 (在插件目录执行 npm install)');
            this._renderer = null;
        }
    }

    // ==================== 核心过滤逻辑 ====================

    /**
     * 出站消息过滤器
     * @param {OutboundMessage} message
     * @returns {OutboundMessage|null}
     */
    filterOutbound(message) {
        if (!message || !message.content) return message;
        if (this.getConfig('enabled') !== true) return message;
        if (!this._renderer || !this._renderer.ready) return message;

        // 平台过滤
        const platforms = this.getConfig('applyToPlatforms') || [];
        if (platforms.length > 0 && !platforms.includes(message.platform)) return message;

        // 递归守卫：已被本插件处理过的消息跳过
        if (message.metadata?._msg2imgProcessed) return message;

        // 判断是否需要渲染
        const renderMode = this.getConfig('renderMode') || 'auto';
        const { shouldRender, renderContent, isExcerpt } = this._extractRenderContent(message.content, renderMode);

        if (!shouldRender) return message;

        // 异步渲染（不阻塞过滤器链）
        this._renderAndReplace(message, renderContent, isExcerpt);

        // 返回原消息（渲染完成前先放行；渲染完成后用 sendDirect 补发图片）
        // 但这样会导致原文本也被发送——所以改为：先丢弃原消息，渲染完成后补发
        return null;
    }

    /**
     * 根据渲染模式提取要渲染的内容
     * @returns {{ shouldRender: boolean, renderContent: string, isExcerpt: boolean }}
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
        if (!gateway) return;

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

            // 渲染
            const imageUrl = await this._renderer.render(
                this._escapeHtml(renderContent),
                css,
                template,
                stRules,
                variables
            );

            // 构造图片消息
            const imgMsg = new OutboundMessage({
                platform: originalMessage.platform,
                chatId: originalMessage.chatId,
                chatType: originalMessage.chatType,
                content: '',
                mediaUrls: [imageUrl],
                replyToId: originalMessage.replyToId || '',
            });
            imgMsg.metadata = { ...originalMessage.metadata, _msg2imgProcessed: true };

            // 如果是截取模式（tagged），原消息还需要发送（去掉标签内容的部分）
            if (isExcerpt) {
                // 先发送剩余文本（去掉标签块的内容）
                const tag = this.getConfig('renderTag') || 'maintext';
                const tagRegex = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'i');
                const remainingText = originalMessage.content.replace(tagRegex, '').trim();

                if (remainingText) {
                    originalMessage.content = remainingText;
                    originalMessage.metadata._msg2imgProcessed = true;
                    // 放行原消息（去掉标签后的剩余文本）
                    gateway.sendDirect(originalMessage, { bypassFilters: true, skipDedup: true });
                }
            }

            // 发送图片
            await gateway.sendDirect(imgMsg, { bypassFilters: true, skipDedup: true });
            this.logger.info(`消息已渲染为图片: ${imageUrl}`);
        } catch (err) {
            this.logger.error(`渲染失败，回退为原文本: ${err.message}`);
            // 渲染失败：补发原始消息
            const fallbackMsg = new OutboundMessage({
                platform: originalMessage.platform,
                chatId: originalMessage.chatId,
                chatType: originalMessage.chatType,
                content: originalMessage.content,
                replyToId: originalMessage.replyToId || '',
            });
            fallbackMsg.metadata = { ...originalMessage.metadata, _msg2imgProcessed: true };
            await gateway.sendDirect(fallbackMsg, { bypassFilters: true, skipDedup: true });
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
        // 每 24 小时清理一次
        this._cleanupTimer = setInterval(() => {
            if (this._renderer) {
                this._renderer.cleanupCache(cacheDays).catch(() => {});
            }
        }, 24 * 60 * 60 * 1000);
    }

    // ==================== ST 正则规则导入 ====================

    /**
     * 从 SillyTavern 正则规则导入
     * 兼容 ST 原生字段格式（find_regex / findRegex / pattern 等）
     * @param {string|object|array} input - ST 正则规则 JSON
     * @returns {{ imported: number, skipped: number }}
     */
    importFromST(input) {
        let rules = input;

        // 解析输入
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

            // 过滤：只导入 display 规则
            if (normalized.destination && normalized.destination.display !== true) {
                skipped++;
                continue;
            }

            // 去重
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
        this.logger.info(`ST 正则规则导入: ${imported} 条导入, ${skipped} 条跳过`);
        return { imported, skipped };
    }

    /**
     * 规范化 ST 正则规则字段
     */
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
                return ctx.reply('✅ 消息转图片已开启');
            case 'off':
                this.setConfig('enabled', false);
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
        const platforms = this.getConfig('applyToPlatforms') || [];

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
            `  缓存大小: ${cacheMB} MB`,
            `  生效平台: ${platforms.length ? platforms.join(', ') : '全部'}`,
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

            const imageUrl = await this._renderer.render(
                this._escapeHtml(sampleText),
                css,
                template,
                stRules,
                { roleName: '师尊', time: new Date().toLocaleString('zh-CN', { hour12: false }), messageId: 'test' }
            );

            // 发送测试图片
            await ctx.reply('🧪 渲染测试结果：', { mediaUrls: [imageUrl] });
        } catch (err) {
            return ctx.reply(`❌ 渲染失败: ${err.message}`);
        }
    }

    async _cmdClearCache(ctx) {
        if (!this._renderer) return ctx.reply('渲染引擎未初始化');

        const cacheDir = this._renderer.cacheDir;
        try {
            const fs = await import('fs/promises');
            const files = await fs.readdir(cacheDir);
            for (const file of files) {
                await fs.unlink(path.join(cacheDir, file));
            }
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

    async _cmdHelp(ctx) {
        return ctx.reply([
            '🖼️ 消息转图片插件 v1.0',
            '',
            '命令:',
            '  /msg2img on - 开启',
            '  /msg2img off - 关闭',
            '  /msg2img status - 查看状态',
            '  /msg2img test - 渲染测试',
            '  /msg2img clear-cache - 清理缓存',
            '  /msg2img import-st <JSON> - 导入 ST 正则规则',
            '',
            '配置可通过面板「插件管理」中的配置按钮修改',
            '支持自定义模板、CSS、ST 正则规则导入',
            '渲染模式: auto(长度阈值) / always(全部) / tagged(标签内)',
        ].join('\n'));
    }
}
