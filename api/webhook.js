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

    const myUserId = process.env.LINE_USER_ID;

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const replyToken = event.replyToken;
            const userId = event.source.userId;
            const text = event.message.text.trim();

            // 安全防護：如果不是主人傳的訊息，直接忽略或回絕
            if (myUserId && userId !== myUserId) {
                await replyToLine(replyToken, "⛔ 抱歉，您沒有權限使用此機器人。");
                continue;
            }

            // 讀取目前的設定
            let config = await getConfig();
            let keywordsArray = config.keyword 
                ? config.keyword.split(/[\n,]+/).map(k => k.trim()).filter(k => k.length > 0)
                : [];

            let replyMessage = "";

            if (text.startsWith("新增 ")) {
                const newKeyword = text.replace("新增 ", "").trim();
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
                    replyMessage = "請輸入要新增的商品，例如：「新增 PS5」";
                }

            } else if (text.startsWith("刪除 ")) {
                const removeKeyword = text.replace("刪除 ", "").trim();
                if (removeKeyword) {
                    const originalLength = keywordsArray.length;
                    keywordsArray = keywordsArray.filter(k => k !== removeKeyword);
                    if (keywordsArray.length < originalLength) {
                        config.keyword = keywordsArray.join('\n');
                        await saveConfig(config);
                        replyMessage = `🗑️ 已移除追蹤：${removeKeyword}`;
                    } else {
                        replyMessage = `找不到名為「${removeKeyword}」的追蹤項目喔！`;
                    }
                } else {
                    replyMessage = "請輸入要刪除的商品，例如：「刪除 PS5」";
                }

            } else if (text === "列表") {
                if (keywordsArray.length > 0) {
                    replyMessage = `📋 目前追蹤中的商品 (${keywordsArray.length})：\n` + keywordsArray.map(k => `• ${k}`).join('\n');
                    replyMessage += `\n\n檢查頻率：${config.interval} 分鐘`;
                } else {
                    replyMessage = "📭 目前沒有追蹤任何商品。\n可以輸入「新增 薩爾達」來加入！";
                }

            } else if (text.startsWith("頻率 ")) {
                const minutes = parseInt(text.replace("頻率 ", "").trim());
                if (!isNaN(minutes) && minutes > 0) {
                    config.interval = minutes.toString();
                    await saveConfig(config);
                    replyMessage = `⏱️ 已將檢查頻率更新為每 ${minutes} 分鐘一次。`;
                } else {
                    replyMessage = "請輸入正確的數字，例如：「頻率 5」";
                }

            } else {
                // 指令教學
                replyMessage = `🤖 【控制台指令教學】\n\n` +
                               `🔹 新增商品：\n輸入「新增 Nintendo Switch」\n\n` +
                               `🔹 刪除商品：\n輸入「刪除 PS5」\n\n` +
                               `🔹 查看清單：\n輸入「列表」\n\n` +
                               `🔹 更改頻率：\n輸入「頻率 10」`;
            }

            // 發送回覆
            await replyToLine(replyToken, replyMessage);
        }
    }

    return res.status(200).json({ success: true });
}
