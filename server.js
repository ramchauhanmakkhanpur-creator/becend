const express = require('express');
const cors = require('cors');
const ytSearch = require('yt-search');
const fs = require('fs');

const USE_TELEGRAM = false; // ज़रूरत हो तो true करें
const TELEGRAM_BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE';
const ADMIN_CHAT_ID = 'YOUR_ADMIN_CHAT_ID';

let bot = null;
if (USE_TELEGRAM && TELEGRAM_BOT_TOKEN !== 'YOUR_BOT_TOKEN_HERE' && ADMIN_CHAT_ID !== 'YOUR_ADMIN_CHAT_ID') {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
    bot.onText(/\/approve (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const userId = match[1].trim();
        if (chatId.toString() !== ADMIN_CHAT_ID.toString()) {
            bot.sendMessage(chatId, '❌ अनऑथराइज़्ड');
            return;
        }
        const db = readDB();
        const request = db.requests.find(r => r.userId === userId);
        if (!request) return bot.sendMessage(chatId, '❌ रिक्वेस्ट नहीं मिली');
        request.status = 'approved';
        const user = db.users.find(u => u.id === userId);
        if (user) user.mb = 0;
        writeDB(db);
        bot.sendMessage(chatId, `✅ रिचार्ज अप्रूव्ड (User: ${user?.name || userId})`);
    });
} else {
    console.log('ℹ️ Telegram bot disabled.');
}

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = './db.json';

function readDB() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { return { users: [], requests: [] }; }
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// सामान्य वीडियो के लिए कीवर्ड्स
const homeKeywords = ["vlog india", "podcast hindi", "tech reviews india", "indian web series", "roast video hindi", "stand up comedy hindi", "travel vlog india", "shark tank india"];

// वीडियो एंडपॉइंट – shorts टाइप भी सपोर्ट करता है
app.get('/api/videos', async (req, res) => {
    const { q = 'trending', page = 1, type = 'search' } = req.query;
    try {
        let searchQuery = q;
        if (type === 'home') {
            const randomKeyword = homeKeywords[Math.floor(Math.random() * homeKeywords.length)];
            searchQuery = `${randomKeyword} part ${page}`;
        } else if (type === 'shorts') {
            // शॉर्ट्स के लिए #shorts या 1 मिनट से कम की वीडियो ढूँढता है
            searchQuery = `#shorts part ${page}`;
        } else {
            if (page > 1) searchQuery = `${q} part ${page}`;
        }

        const r = await ytSearch(searchQuery);
        let videos = r.videos;

        if (type === 'home') {
            videos = videos.filter(v => v.seconds > 240);  // 4 मिनट से बड़ी
        } else if (type === 'shorts') {
            videos = videos.filter(v => v.seconds <= 60);   // 60 सेकंड से कम
        }

        const finalVideos = videos.slice(0, 20).map(v => ({
            videoId: v.videoId,
            title: v.title,
            thumbnail: v.thumbnail,
            author: v.author.name,
            duration: v.timestamp
        }));
        res.json({ results: finalVideos });
    } catch (err) {
        console.error('Video fetch error:', err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// यूज़र APIs (बिना किसी बदलाव के)
app.post('/api/signup', (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
    const db = readDB();
    if (db.users.find(u => u.name === name)) return res.status(400).json({ error: 'User already exists' });
    const newUser = { id: Date.now().toString(), name, password, mb: 0, earnData: true, createdAt: new Date().toISOString() };
    db.users.push(newUser);
    writeDB(db);
    res.json({ id: newUser.id, name: newUser.name, mb: newUser.mb });
});

app.post('/api/login', (req, res) => {
    const { name, password } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.name === name && u.password === password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ id: user.id, name: user.name, mb: user.mb });
});

app.get('/api/user/:id', (req, res) => {
    const db = readDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const request = db.requests.find(r => r.userId === user.id);
    res.json({
        id: user.id, name: user.name, mb: user.mb,
        rechargeStatus: request ? request.status : null,
        mobile: request ? request.mobile : null,
        sim: request ? request.sim : null
    });
});

app.post('/api/recharge-request/:id', (req, res) => {
    const { mobile, sim } = req.body;
    if (!mobile || !sim) return res.status(400).json({ error: 'Mobile and sim required' });
    const db = readDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.mb < 1000) return res.status(400).json({ error: 'Not enough MB yet' });
    let existingRequest = db.requests.find(r => r.userId === user.id);
    if (existingRequest) {
        existingRequest.mobile = mobile;
        existingRequest.sim = sim;
        existingRequest.status = 'pending';
    } else {
        db.requests.push({ userId: user.id, userName: user.name, mobile, sim, status: 'pending' });
    }
    writeDB(db);
    if (bot) {
        const message = `🔔 New Recharge Request\n👤 User: ${user.name}\n📱 Mobile: ${mobile}\n📶 SIM: ${sim}\n🆔 User ID: ${user.id}\n\nType /approve ${user.id} to approve.`;
        bot.sendMessage(ADMIN_CHAT_ID, message).catch(err => console.log('Telegram send error:', err));
    }
    res.json({ message: 'Recharge request sent for approval', status: 'pending' });
});

app.post('/api/approve-recharge', (req, res) => {
    const { userId } = req.body;
    const db = readDB();
    const request = db.requests.find(r => r.userId === userId);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    request.status = 'approved';
    const user = db.users.find(u => u.id === userId);
    if (user) user.mb = 0;
    writeDB(db);
    res.json({ message: 'Recharge approved', status: 'approved' });
});

app.get('/api/user-count', (req, res) => {
    const db = readDB();
    res.json({ count: db.users.length });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
