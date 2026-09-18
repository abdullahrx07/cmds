const axios = require("axios");

// Base URL is pulled from the "pin" key of this shared config, instead of
// being hardcoded here.
const CONFIG_URL = "https://raw.githubusercontent.com/abdullahrx07/X-api/refs/heads/main/MaRiA/baseApiUrl.json";
const CACHE_TTL = 5 * 60 * 1000; // 5 min

let cachedBaseUrl = null;
let cachedAt = 0;

async function getBaseUrl() {
  const now = Date.now();
  if (cachedBaseUrl && now - cachedAt < CACHE_TTL) return cachedBaseUrl;

  const res = await axios.get(CONFIG_URL, { timeout: 10000 });
  const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

  let pinUrl;
  try {
    const parsed = typeof res.data === "object" ? res.data : JSON.parse(raw);
    pinUrl = parsed.pin;
  } catch {
    // config file isn't always strict JSON (missing commas etc.) — fall
    // back to pulling the "pin" value out with a regex.
    const m = raw.match(/"pin"\s*:\s*"([^"]+)"/);
    pinUrl = m && m[1];
  }

  if (!pinUrl) throw new Error("pin key not found in config");
  cachedBaseUrl = pinUrl.replace(/\/+$/, "");
  cachedAt = now;
  return cachedBaseUrl;
}

// axios error responses come back as streams; read the body to surface the
// server's JSON detail (e.g. the 502 from a failed ffmpeg run).
async function readErrorBody(err) {
  const stream = err.response?.data;
  if (!stream || typeof stream.on !== "function") return null;
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    return typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
  } catch {
    return null;
  }
}

async function fetchAttachment(url, filename) {
  const res = await axios.get(url, {
    responseType: "stream",
    timeout: 90000,
    validateStatus: (s) => s === 200
  });
  res.data.path = filename;
  return res.data;
}

async function downloadVideo({ api, item, choice, message }) {
  const waitMsg = choice
    ? await message.reply(`⬇️ Downloading video ${choice}...`)
    : await message.reply(`⬇️ Downloading video...`);
  try {
    const dlUrl = item.download_url.startsWith("http")
      ? item.download_url
      : `${await getBaseUrl()}${item.download_url}`;
    const attachment = await fetchAttachment(dlUrl, `${item.id}.mp4`);
    await message.reply({ attachment });
  } catch (e) {
    const reason = await readErrorBody(e) || e.message;
    await message.reply(`❌ Failed to download video${choice ? ` ${choice}` : ""}.\nReason: ${reason}`);
  } finally {
    if (waitMsg && waitMsg.messageID) {
      try { api.unsendMessage(waitMsg.messageID); } catch {}
    }
  }
}

module.exports = {
  config: {
    name: "Pinterest",
    aliases: ["pin"],
    version: "1.2.0",
    author: "rX",
    countDown: 5,
    role: 0,
    shortDescription: "Search Pinterest images/videos",
    longDescription: "Search Pinterest via Pinterest-xdi API and send images or videos (with sound).",
    category: "media",
    guide: {
      en: "{pn} <query> [-N]        (image, default)\n{pn} -v <query> [-N]     (video)\nEx: {pn} flowers -3\nEx: {pn} -v sunset -7"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    if (!args.length) return message.reply("⚠️ Usage: !pin <query> [-N]  |  !pin -v <query> [-N]");

    let mode = "image";
    let num = 10;
    const queryParts = [];

    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower === "-v" || lower === "-video" || lower === "video") {
        mode = "video";
      } else if (lower === "-i" || lower === "-image" || lower === "image") {
        mode = "image";
      } else if (/^-\d+$/.test(arg)) {
        num = Math.min(10, Math.max(1, parseInt(arg.slice(1), 10)));
      } else {
        queryParts.push(arg);
      }
    }

    const query = queryParts.join(" ").trim();
    if (!query) return message.reply("⚠️ Please provide a search query.");

    // "video" in the query doubles as a search hint for Pinterest's own
    // ranking — without it video searches often come back empty.
    const searchQuery = mode === "video" ? `${query} video` : query;

    const waitMsg = await message.reply(`🔍 Searching Pinterest for "${query}" (${mode}, ${num})...`);

    try {
      const baseUrl = await getBaseUrl();
      const doSearch = () =>
        axios.get(`${baseUrl}/api/search`, {
          params: { q: searchQuery, mode, num },
          timeout: 60000
        });

      let { data } = await doSearch();
      let results = Array.isArray(data) ? data : data.results;

      if (!results || !results.length) {
        // one retry — Render free tier cold start / transient empty scrape
        ({ data } = await doSearch());
        results = Array.isArray(data) ? data : data.results;
      }

      if (!results || !results.length) {
        return message.reply(`❌ No ${mode} results found for "${query}".`);
      }

      if (mode === "image") {
        // Images are small — send them all directly, no picker needed.
        const attachments = [];
        for (const item of results) {
          try {
            attachments.push(await fetchAttachment(item.download_url, `${item.id}.jpg`));
          } catch {
            // skip failed image
          }
        }
        if (!attachments.length) return message.reply("❌ Failed to fetch images.");
        return message.reply({
          body: `✅ Found ${attachments.length} image(s) for "${query}"`,
          attachment: attachments
        });
      }

      // Video mode with a single result (e.g. "-1"): skip the picker and
      // download it directly.
      if (results.length === 1) {
        return downloadVideo({ api, item: results[0], message });
      }

      // Video mode with multiple results: send thumbnails with numbers,
      // user replies with a number to pick which video to download.
      const thumbs = [];
      const list = [];
      results.forEach((item, i) => {
        const dur = item.duration_ms ? ` (${Math.round(item.duration_ms / 1000)}s)` : "";
        list.push(`${i + 1}.${dur} ${item.alt || "No title"}`.slice(0, 80));
      });
      for (const item of results) {
        try {
          thumbs.push(await fetchAttachment(item.thumbnail, `${item.id}.jpg`));
        } catch {
          // skip failed thumbnail
        }
      }
      if (!thumbs.length) return message.reply("❌ Failed to load thumbnails.");

      const pickMsg = await message.reply({
        body: `🎬 Found ${thumbs.length} video(s) for "${query}"\n\n${list.join("\n")}\n\n👉 Reply with a number (1-${thumbs.length}) to download`,
        attachment: thumbs
      });

      global.GoatBot.onReply.set(pickMsg.messageID, {
        commandName: this.config.name,
        messageID: pickMsg.messageID,
        author: event.senderID,
        results
      });
    } catch (err) {
      const reason = await readErrorBody(err) || err.message;
      return message.reply(`❌ Error: ${reason}`);
    } finally {
      if (waitMsg && waitMsg.messageID) {
        try { api.unsendMessage(waitMsg.messageID); } catch {}
      }
    }
  },

  onReply: async function ({ api, event, Reply, message }) {
    if (event.senderID !== Reply.author) return;

    const choice = parseInt(event.body?.trim(), 10);
    const item = Reply.results[choice - 1];
    if (!choice || !item) {
      return message.reply(`⚠️ Please reply with a number between 1 and ${Reply.results.length}.`);
    }
    global.GoatBot.onReply.delete(Reply.messageID);
    return downloadVideo({ api, item, choice, message });
  }
};
