require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');

// 載入 Stealth 外掛以繞過防爬蟲機制
puppeteer.use(StealthPlugin());

const DATA_FILE = path.join(__dirname, 'data.json');

// 初始化 Redis (如果未設定 REDIS_URL，則嘗試只用本機設定，但警告用戶)
let redis = null;
if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
    console.log("已連線至雲端 Redis 控制台");
} else {
    console.log("尚未設定 REDIS_URL，無法接收 Vercel 控制台的更新！");
}

// 讀取紀錄 (包含已處理的商品與已初始化的關鍵字)
function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        return { seenItems: [], seenKeywords: [] };
    }
    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return {
            seenItems: data.seenItems || [],
            seenKeywords: data.seenKeywords || []
        };
    } catch (e) {
        return { seenItems: [], seenKeywords: [] };
    }
}

// 儲存紀錄
function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 發送 LINE 通知 (支援發送給多個目標)
async function sendLineNotification(item, lineToken, targetIds) {
    if (!lineToken || !targetIds || targetIds.length === 0) {
        console.log("未設定 LINE 憑證或沒有訂閱者，跳過通知發送。");
        return;
    }

    const message = {
        messages: [
            {
                type: "flex",
                altText: `新商品上架！`,
                contents: {
                    type: "bubble",
                    hero: item.imgUrl ? {
                        type: "image",
                        url: item.imgUrl,
                        size: "full",
                        aspectRatio: "1:1",
                        aspectMode: "cover"
                    } : undefined,
                    body: {
                        type: "box",
                        layout: "vertical",
                        contents: [
                            {
                                type: "text",
                                text: "Mercari 新上架通知",
                                weight: "bold",
                                color: "#1DB446",
                                size: "sm"
                            },
                            {
                                type: "text",
                                text: item.title || "點擊查看詳情",
                                weight: "bold",
                                size: "xl",
                                margin: "md",
                                wrap: true
                            }
                        ]
                    },
                    footer: {
                        type: "box",
                        layout: "vertical",
                        contents: [
                            {
                                type: "button",
                                style: "primary",
                                color: "#E02B33",
                                action: {
                                    type: "uri",
                                    label: "立即前往 Mercari",
                                    uri: item.url
                                }
                            }
                        ]
                    }
                }
            }
        ]
    };

    // 對每個目標發送推播
    for (const targetId of targetIds) {
        message.to = targetId;
        try {
            await axios.post('https://api.line.me/v2/bot/message/push', message, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${lineToken}`
                }
            });
            console.log(`已發送 LINE 通知至: ${targetId}`);
        } catch (error) {
            console.error(`LINE 通知發送給 ${targetId} 失敗:`, error.response ? error.response.data : error.message);
        }
    }
}

// 核心爬蟲函式
async function checkMercari(config) {
    const { keyword, lineToken, targetIds } = config;
    if (!keyword) {
        console.log("尚未設定尋寶關鍵字，略過檢查。");
        return;
    }

    console.log(`\n[${new Date().toLocaleString()}] 開始檢查 "${keyword}" 的最新商品...`);
    
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800']
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const targetUrl = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&sort=created_time&order=desc`;
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('a[href^="/item/m"]', { timeout: 30000 });

        const { validItems, stats } = await page.evaluate(() => {
            const results = [];
            const links = Array.from(document.querySelectorAll('a[href^="/item/m"]')).slice(0, 40);
            const nowSeconds = Math.floor(Date.now() / 1000);
            
            let totalCount = links.length;
            let soldOutCount = 0;
            let oldCount = 0;

            links.forEach(a => {
                const isSoldOut = a.querySelector('[aria-label="売り切れ"]') !== null;
                if (isSoldOut) {
                    soldOutCount++;
                    return;
                }

                const href = a.getAttribute('href');
                const id = href.split('/').pop();
                const img = a.querySelector('img');
                const imgUrl = img ? (img.src || img.getAttribute('src')) : null;
                const ariaLabel = a.getAttribute('aria-label') || '';
                
                let isTooOld = false;
                if (imgUrl && imgUrl.includes('?')) {
                    const tsStr = imgUrl.split('?')[1];
                    const ts = parseInt(tsStr, 10);
                    if (!isNaN(ts) && (nowSeconds - ts > 86400)) {
                        isTooOld = true;
                        oldCount++;
                    }
                }
                if (isTooOld) return;

                results.push({
                    id: id,
                    url: `https://jp.mercari.com${href}`,
                    imgUrl: imgUrl,
                    title: ariaLabel
                });
            });
            return { validItems: results, stats: { totalCount, soldOutCount, oldCount } };
        });

        const items = validItems;
        console.log(`掃描 ${stats.totalCount} 個商品 -> 排除 ${stats.soldOutCount} 個已售出、${stats.oldCount} 個舊商品 -> 剩餘 ${items.length} 個有效商品。`);

        let { seenItems, seenKeywords } = loadData();
        let newItemsFound = false;
        
        const isNewKeyword = !seenKeywords.includes(keyword);

        if (isNewKeyword) {
            console.log(`初次掃描關鍵字 "${keyword}"，執行靜默初始化 (儲存為基準，不發送通知)...`);
            for (const item of items) {
                if (!seenItems.includes(item.id)) {
                    seenItems.push(item.id);
                    newItemsFound = true;
                }
            }
            seenKeywords.push(keyword);
        } else {
            for (let i = items.length - 1; i >= 0; i--) {
                const item = items[i];
                
                if (!seenItems.includes(item.id)) {
                    console.log(`發現新商品: ${item.id} - ${item.title.substring(0, 30)}...`);
                    await sendLineNotification(item, lineToken, targetIds);
                    
                    seenItems.push(item.id);
                    newItemsFound = true;
                    
                    // 隨機延遲 1~2 秒，避免被 LINE API 限制
                    await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
                }
            }
        }

        if (seenItems.length > 5000) {
            seenItems = seenItems.slice(-5000);
        }

        if (newItemsFound || isNewKeyword) {
            saveData({ seenItems, seenKeywords });
            if (!newItemsFound) {
                console.log("靜默初始化完成，已寫入紀錄。");
            }
        } else {
            console.log("沒有發現新上架的商品。");
        }

    } catch (error) {
        console.error("爬蟲執行發生錯誤:", error.message);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// 主控迴圈 (定時去 Redis 抓設定)
async function startLoop() {
    console.log("Mercari 雙棲爬蟲機器人已啟動！正等待雲端指令...");

    while (true) {
        let config = { keyword: null };
        
        if (redis) {
            try {
                const data = await redis.get('mercari_config');
                if (data) {
                    config = JSON.parse(data);
                }
            } catch (e) {
                console.error("無法從 Redis 讀取設定:", e.message);
            }
        } else {
            // 如果沒設定 Redis，就使用本地 .env
            config.keyword = process.env.SEARCH_KEYWORD;
        }
        
        // 取得所有曾傳訊息給機器人的訂閱者
        let targetIds = [];
        if (redis) {
            try {
                targetIds = await redis.smembers('mercari_subscribers');
            } catch (e) {
                console.error("無法取得訂閱者名單");
            }
        }
        
        // 如果雲端沒有名單，就預設傳給本地設定的老闆
        if (targetIds.length === 0 && process.env.LINE_USER_ID) {
            targetIds = [process.env.LINE_USER_ID];
        }
        
        config.targetIds = targetIds;
        
        // 從本地 .env 讀取機密資訊與檢查頻率
        config.lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        config.interval = parseInt(config.interval) || parseInt(process.env.CHECK_INTERVAL_MINUTES) || 5;

        // 檢查是否有遠端關機指令
        if (config.command === 'shutdown') {
            console.log("\n收到雲端關機指令！正在關閉爬蟲...");
            // 清除雲端的關機指令，以免下次一啟動又立刻關機
            config.command = '';
            if (redis) {
                await redis.set('mercari_config', JSON.stringify(config));
            }
            // 發送最後的道別通知
            for (const targetId of targetIds) {
                try {
                    await axios.post('https://api.line.me/v2/bot/message/push', {
                        to: targetId,
                        messages: [{ type: 'text', text: '爬蟲機器人已成功關機，辛苦了！\n(若要重新啟動，請回家打開電腦執行 start.bat)' }]
                    }, {
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.lineToken}` }
                    });
                } catch (e) {}
            }
            process.exit(0);
        }

        if (config.keyword) {
            // 將關鍵字字串依換行或逗號切割成陣列，並去除空白與空字串
            const keywordsArray = config.keyword
                .split(/[\n,]+/)
                .map(k => k.trim())
                .filter(k => k.length > 0);
            
            if (keywordsArray.length > 0) {
                console.log(`\n準備掃描 ${keywordsArray.length} 組商品...`);
                for (let i = 0; i < keywordsArray.length; i++) {
                    const singleKeyword = keywordsArray[i];
                    // 覆寫 config.keyword 傳入單一關鍵字
                    await checkMercari({ ...config, keyword: singleKeyword });
                    
                    // 除了最後一個，每個關鍵字掃描完休息隨機秒數，避免被封鎖
                    if (i < keywordsArray.length - 1) {
                        const waitTime = 3000 + Math.floor(Math.random() * 2000);
                        console.log(`休息 ${Math.round(waitTime / 1000)} 秒鐘後繼續下一個商品...`);
                        await new Promise(r => setTimeout(r, waitTime));
                    }
                }
            } else {
                console.log("關鍵字列表為空，休眠中...");
            }
        } else {
            console.log("雲端控制台尚未設定關鍵字，休眠中...");
        }

        const intervalMs = (parseInt(config.interval) || 5) * 60 * 1000;
        console.log(`等待 ${config.interval} 分鐘後再次檢查...\n`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

// 啟動無窮迴圈
startLoop();
