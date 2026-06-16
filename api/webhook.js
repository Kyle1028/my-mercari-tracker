import Redis from 'ioredis';

// 初始化 Redis
const redis = new Redis(process.env.REDIS_URL || process.env.KV_URL);

// 發送回覆訊息到 LINE
async function replyToLine(replyToken, text) {
    const channelToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!channelToken) {
        console.error("Missing LINE_CHANNEL_ACCESS_TOKEN");
        return;
    }

    try {
        await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${channelToken}`
            },
            body: JSON.stringify({
                replyToken: replyToken,
                messages: [{ type: 'text', text: text }]
            })
        });
    } catch (error) {
        console.error("Reply Error:", error);
    }
}

// 取得與更新設定的輔助函式
async function getConfig() {
    try {
        const data = await redis.get('mercari_config');
        return data ? JSON.parse(data) : { keyword: '', interval: '5' };
    } catch (e) {
        return { keyword: '', interval: '5' };
    }
}

async function saveConfig(config) {
    await redis.set('mercari_config', JSON.stringify(config));
}

export default async function handler(req, res) {
    // LINE Webhook 驗證請求 (回傳 200)
    if (req.method === 'GET') {
        return res.status(200).send('Webhook is active');
    }

    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    const events = req.body.events;
    if (!events || events.length === 0) {
        return res.status(200).send('No events');
    }

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const replyToken = event.replyToken;
            // 支援群組或個人對話
            const sourceId = event.source.groupId || event.source.userId;
            const text = event.message.text.trim();

            // 將發言的群組或個人加入訂閱廣播名單
            if (sourceId) {
                await redis.sadd('mercari_subscribers', sourceId);
            }

            // 讀取目前的對話狀態
            let state = null;
            if (sourceId) {
                state = await redis.get(`state:${sourceId}`);
            }

            // 讀取共用的設定
            let config = await getConfig();
            let keywordsArray = config.keyword 
                ? config.keyword.split(/[\n,]+/).map(k => k.trim()).filter(k => k.length > 0)
                : [];

            let replyMessage = "";

            // 1. 處理主選單按鈕的純指令 (進入等待狀態)
            if (text === "新增") {
                await redis.setex(`state:${sourceId}`, 300, 'add');
                replyMessage = "✏️ 請輸入您想「新增追蹤」的商品名稱：\n(例如：Nintendo Switch)";
            } else if (text === "刪除") {
                await redis.setex(`state:${sourceId}`, 300, 'delete');
                replyMessage = "🗑️ 請輸入您想「刪除」的商品名稱：\n(請輸入與列表完全相同的名稱)";
            } else if (text === "頻率") {
                await redis.setex(`state:${sourceId}`, 300, 'interval');
                replyMessage = "⏱️ 請輸入您希望的「檢查頻率」(分鐘)：\n(請輸入純數字，例如：5)";
            } else if (text === "列表") {
                if (keywordsArray.length > 0) {
                    replyMessage = `📋 目前追蹤中的商品 (${keywordsArray.length})：\n` + keywordsArray.map(k => `• ${k}`).join('\n');
                    replyMessage += `\n\n檢查頻率：${config.interval} 分鐘`;
                } else {
                    replyMessage = "📭 目前沒有追蹤任何商品。\n可以點擊「新增」來加入！";
                }
            } 
            // 2. 處理狀態機的後續回答 或 舊版的一行指令
            else if (state === 'add' || text.startsWith("新增 ")) {
                const newKeyword = state === 'add' ? text : text.replace("新增 ", "").trim();
                if (newKeyword) {
                    if (!keywordsArray.includes(newKeyword)) {
                        keywordsArray.push(newKeyword);
                        config.keyword = keywordsArray.join('\n');
                        await saveConfig(config);
                        replyMessage = `✅ 已新增追蹤：${newKeyword}\n目前共追蹤 ${keywordsArray.length} 項商品。`;
                    } else {
                        replyMessage = `⚠️ 「${newKeyword}」已經在追蹤清單中囉！`;
                    }
                } else {
                    replyMessage = "商品名稱不能為空喔！";
                }
                await redis.del(`state:${sourceId}`);

            } else if (state === 'delete' || text.startsWith("刪除 ")) {
                const removeKeyword = state === 'delete' ? text : text.replace("刪除 ", "").trim();
                if (removeKeyword) {
                    const originalLength = keywordsArray.length;
                    keywordsArray = keywordsArray.filter(k => k !== removeKeyword);
                    if (keywordsArray.length < originalLength) {
                        config.keyword = keywordsArray.join('\n');
                        await saveConfig(config);
                        replyMessage = `🗑️ 已移除追蹤：${removeKeyword}`;
                    } else {
                        replyMessage = `找不到名為「${removeKeyword}」的追蹤項目喔！\n(請點擊「列表」確認正確名稱)`;
                    }
                }
                await redis.del(`state:${sourceId}`);

            } else if (state === 'interval' || text.startsWith("頻率 ")) {
                const minutesText = state === 'interval' ? text : text.replace("頻率 ", "").trim();
                const minutes = parseInt(minutesText);
                if (!isNaN(minutes) && minutes > 0) {
                    config.interval = minutes.toString();
                    await saveConfig(config);
                    replyMessage = `⏱️ 已將檢查頻率更新為每 ${minutes} 分鐘一次。`;
                } else {
                    replyMessage = "請輸入正確的純數字，例如：5";
                }
                await redis.del(`state:${sourceId}`);

            } else {
                // 如果沒有狀態，且輸入了無法辨識的文字
                replyMessage = `🤖 【小秘書使用說明】\n\n您可以點擊下方的選單按鈕，或是直接輸入以下文字：\n\n🔹 新增\n🔹 刪除\n🔹 列表\n🔹 頻率`;
            }

            // 發送回覆
            await replyToLine(replyToken, replyMessage);
        }
    }

    return res.status(200).json({ success: true });
}
