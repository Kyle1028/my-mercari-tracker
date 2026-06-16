import { Redis } from '@upstash/redis';

// 初始化 Redis 連線 (使用 Vercel 環境變數中的 REDIS_URL)
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.REDIS_URL,
  token: process.env.KV_REST_API_TOKEN || "token",
});

export default async function handler(req, res) {
    // 解決 CORS 問題
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        if (req.method === 'GET') {
            // 讀取目前的設定
            const config = await redis.get('mercari_config');
            if (!config) {
                return res.status(200).json({});
            }
            return res.status(200).json(typeof config === 'string' ? JSON.parse(config) : config);
            
        } else if (req.method === 'POST') {
            // 儲存新的設定
            const config = req.body;
            await redis.set('mercari_config', JSON.stringify(config));
            return res.status(200).json({ success: true });
            
        } else {
            return res.status(405).json({ error: 'Method Not Allowed' });
        }
    } catch (error) {
        console.error('Redis API Error:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
}
