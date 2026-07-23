import puppeteer from 'puppeteer';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 图片渲染引擎
 * 基于 Puppeteer 将 HTML+CSS 渲染为 PNG/JPEG 图片
 * 特性：Browser 复用、Page 池、LRU 文件缓存、并发控制
 */
export class ImageRenderer {
    constructor(options = {}) {
        this.cacheDir = options.cacheDir || path.join(__dirname, 'cache');
        this.options = {
            maxWidth: 800,
            imageFormat: 'png',
            imageQuality: 90,
            maxConcurrent: 2,
            pagePoolSize: 3,
            fontFamily: 'Microsoft YaHei, sans-serif',
            executablePath: '',
            headless: true,
            ...options,
        };
        this.browser = null;
        this.pagePool = [];
        this.queue = [];
        this.running = 0;
        this.ready = false;
    }

    /**
     * 初始化 Puppeteer 浏览器和页面池
     */
    async init() {
        await fs.mkdir(this.cacheDir, { recursive: true });

        const launchOptions = {
            headless: this.options.headless ? 'new' : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--font-render-hinting=none',
            ],
        };

        if (this.options.executablePath) {
            launchOptions.executablePath = this.options.executablePath;
        }

        this.browser = await puppeteer.launch(launchOptions);

        // 初始化页面池
        for (let i = 0; i < this.options.pagePoolSize; i++) {
            const page = await this.browser.newPage();
            await page.setViewport({ width: this.options.maxWidth, height: 1 });
            this.pagePool.push({ page, busy: false });
        }

        this.ready = true;
    }

    /**
     * 渲染内容
     * @param {string} content - 原始文本（已转义 HTML）
     * @param {string} css - CSS 样式
     * @param {object} template - { html: string, preset: string }
     * @param {Array} rules - ST 正则规则数组
     * @param {object} variables - 变量占位符 { roleName, time, messageId, ... }
     * @returns {Promise<string>} file:/// 图片路径
     */
    async render(content, css, template, rules = [], variables = {}) {
        if (!this.ready) {
            throw new Error('ImageRenderer 未初始化');
        }

        // 1. 应用 ST 正则规则：原始文本 → HTML 片段
        let processedContent = this._applyRules(content, rules);

        // 2. 套入模板并注入变量
        const fullHtml = this._buildHtml(processedContent, css, template, variables);

        // 3. 缓存检查
        const cacheKey = this._getCacheKey(fullHtml);
        const cachedPath = await this._getCachedImage(cacheKey);
        if (cachedPath) {
            return cachedPath;
        }

        // 4. 队列+并发控制渲染
        return this._enqueueRender(fullHtml, cacheKey);
    }

    /**
     * 应用 ST 正则规则
     */
    _applyRules(content, rules) {
        if (!rules || rules.length === 0) return content;

        let result = content;
        for (const rule of rules) {
            if (rule.enabled === false) continue;
            if (!rule.findRegex && !rule.pattern) continue;

            const pattern = rule.findRegex || rule.pattern;
            const replacement = rule.replaceString ?? rule.replacement ?? rule.replace_string ?? '';
            const flags = rule.flags || 'gm';

            try {
                result = result.replace(new RegExp(pattern, flags), replacement);
            } catch (err) {
                // 单条规则失败不影响整体
                console.warn(`[message-to-image] 正则规则失败: ${rule.name || 'unnamed'} - ${err.message}`);
            }
        }
        return result;
    }

    /**
     * 构建完整 HTML 文档
     */
    _buildHtml(content, css, template, variables) {
        const preset = template?.preset || 'novel-card';
        const baseHtml = template?.html || this._getDefaultTemplate(preset);
        const baseCss = css || this._getDefaultCss(preset);

        // 注入变量
        let html = baseHtml;
        html = html.replace(/{{content}}/g, content);
        html = html.replace(/{{fontFamily}}/g, this.options.fontFamily);

        for (const [key, value] of Object.entries(variables)) {
            html = html.replace(new RegExp(`{{${key}}}`, 'g'), String(value ?? ''));
        }

        // 默认 CSS + 用户 CSS
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
${this._getBaseResetCss()}
${baseCss}
</style>
</head>
<body>
${html}
</body>
</html>`;
    }

    /**
     * 基础重置 CSS，确保不同浏览器渲染一致
     */
    _getBaseResetCss() {
        return `
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: ${this.options.fontFamily};
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
                background: transparent;
            }
            .render-root {
                width: ${this.options.maxWidth}px;
                padding: 24px;
            }
        `;
    }

    /**
     * 获取内置模板 HTML
     */
    _getDefaultTemplate(preset) {
        const templates = {
            'novel-card': `<div class="render-root novel-card">
                <div class="card-header">{{roleName}}</div>
                <div class="card-body">{{content}}</div>
                <div class="card-footer">{{time}}</div>
            </div>`,
            'gal-dialogue': `<div class="render-root gal-dialogue">
                <div class="dialogue-name">{{roleName}}</div>
                <div class="dialogue-box">{{content}}</div>
            </div>`,
            'dark-terminal': `<div class="render-root dark-terminal">
                <div class="terminal-header">> MESSAGE_{{messageId}}</div>
                <div class="terminal-body">{{content}}</div>
            </div>`,
            'minimal': `<div class="render-root minimal">{{content}}</div>`,
        };
        return templates[preset] || templates['novel-card'];
    }

    /**
     * 获取内置模板 CSS
     */
    _getDefaultCss(preset) {
        const cssMap = {
            'novel-card': `
                .novel-card { background: linear-gradient(135deg, #f5f0e8 0%, #e8e0d0 100%); border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.15); color: #3a3228; }
                .card-header { font-size: 18px; font-weight: bold; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 2px solid #d4c8b8; color: #6b5b4a; }
                .card-body { font-size: 16px; line-height: 1.8; white-space: pre-wrap; }
                .card-footer { font-size: 12px; color: #999; margin-top: 16px; text-align: right; }
            `,
            'gal-dialogue': `
                .gal-dialogue { background: linear-gradient(180deg, rgba(20,20,40,0.85) 0%, rgba(10,10,25,0.95) 100%); border-radius: 16px; border: 2px solid rgba(100,150,255,0.3); color: #f0f0f5; }
                .dialogue-name { font-size: 20px; font-weight: bold; color: #a0c8ff; margin-bottom: 12px; text-shadow: 0 0 10px rgba(100,150,255,0.5); }
                .dialogue-box { font-size: 17px; line-height: 1.7; white-space: pre-wrap; padding: 16px; background: rgba(255,255,255,0.05); border-radius: 12px; }
            `,
            'dark-terminal': `
                .dark-terminal { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #00ff88; font-family: 'Consolas', 'Monaco', monospace; }
                .terminal-header { font-size: 12px; color: #8b949e; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
                .terminal-body { font-size: 15px; line-height: 1.6; white-space: pre-wrap; }
            `,
            'minimal': `
                .minimal { background: #ffffff; color: #1a1a1a; font-size: 16px; line-height: 1.7; white-space: pre-wrap; }
            `,
        };
        return cssMap[preset] || cssMap['novel-card'];
    }

    /**
     * 渲染队列：控制最大并发
     */
    _enqueueRender(fullHtml, cacheKey) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fullHtml, cacheKey, resolve, reject });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this.running >= this.options.maxConcurrent || this.queue.length === 0) return;

        this.running++;
        const { fullHtml, cacheKey, resolve, reject } = this.queue.shift();

        try {
            const imagePath = await this._doRender(fullHtml, cacheKey);
            resolve(imagePath);
        } catch (err) {
            reject(err);
        } finally {
            this.running--;
            // 继续处理队列中的下一个
            setImmediate(() => this._processQueue());
        }
    }

    /**
     * 实际渲染逻辑
     */
    async _doRender(fullHtml, cacheKey) {
        const poolItem = this._acquirePage();
        if (!poolItem) {
            throw new Error('无法获取渲染页面（页面池耗尽）');
        }

        const { page } = poolItem;
        const fileName = `${cacheKey}.${this.options.imageFormat}`;
        const filePath = path.join(this.cacheDir, fileName);

        try {
            await page.setContent(fullHtml, { waitUntil: 'networkidle0' });

            // 等待字体渲染
            await page.evaluateHandle('document.fonts.ready');

            const element = await page.$('.render-root');
            if (!element) {
                throw new Error('模板中缺少 .render-root 元素');
            }

            // 获取元素实际高度
            const box = await element.boundingBox();

            const screenshotOptions = {
                path: filePath,
                type: this.options.imageFormat,
                clip: {
                    x: 0,
                    y: 0,
                    width: this.options.maxWidth,
                    height: Math.ceil(box.height),
                },
                omitBackground: false,
            };

            if (this.options.imageFormat === 'jpeg') {
                screenshotOptions.quality = this.options.imageQuality;
            }

            await page.screenshot(screenshotOptions);

            return `file:///${filePath.replace(/\\/g, '/')}`;
        } finally {
            this._releasePage(poolItem);
        }
    }

    /**
     * 从页面池获取一个空闲页面
     */
    _acquirePage() {
        const item = this.pagePool.find(p => !p.busy);
        if (item) {
            item.busy = true;
            return item;
        }
        return null;
    }

    /**
     * 释放页面回池
     */
    _releasePage(poolItem) {
        poolItem.busy = false;
    }

    /**
     * 生成缓存键
     */
    _getCacheKey(str) {
        return createHash('sha256').update(str).digest('hex').slice(0, 32);
    }

    /**
     * 检查缓存文件是否存在
     */
    async _getCachedImage(key) {
        const fileName = `${key}.${this.options.imageFormat}`;
        const filePath = path.join(this.cacheDir, fileName);
        try {
            await fs.access(filePath);
            return `file:///${filePath.replace(/\\/g, '/')}`;
        } catch {
            return null;
        }
    }

    /**
     * 清理过期缓存
     * @param {number} maxAgeDays - 超过多少天的文件删除
     */
    async cleanupCache(maxAgeDays = 7) {
        try {
            const files = await fs.readdir(this.cacheDir);
            const now = Date.now();
            const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;

            for (const file of files) {
                const filePath = path.join(this.cacheDir, file);
                try {
                    const stat = await fs.stat(filePath);
                    if (now - stat.mtime.getTime() > maxAge) {
                        await fs.unlink(filePath);
                    }
                } catch (err) {
                    // 忽略单个文件清理失败
                }
            }
        } catch (err) {
            console.warn('[message-to-image] 缓存清理失败:', err.message);
        }
    }

    /**
     * 获取缓存目录大小（字节）
     */
    async getCacheSize() {
        try {
            const files = await fs.readdir(this.cacheDir);
            let size = 0;
            for (const file of files) {
                const stat = await fs.stat(path.join(this.cacheDir, file));
                size += stat.size;
            }
            return size;
        } catch {
            return 0;
        }
    }

    /**
     * 释放资源
     */
    async dispose() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
        this.pagePool = [];
        this.ready = false;
    }
}
