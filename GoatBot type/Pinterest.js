const axios = require("axios");

// Set this to your deployed Pinterest-xdi base URL
const BASE_URL = process.env.PINXDI_BASE_URL || "https://pinterest-api.agi.bd";

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

module.exports = {
  config: {
    name: "pin",
    version: "1.1.0",
    author: "rX",
    countDown: 5,
    role: 0,
    shortDescription: "Search Pinterest images/videos",
    longDescription: "Search Pinterest via Pinterest-xdi API and send images or videos (with sound).",
    category: "media",
    guide: {
      en: "{pn} <query> [video|image] [-N]\nEx: {pn} sunset video -7\nEx: {pn} flowers -3"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    if (!args.length) return message.reply("⚠️ Usage: !pin <query> [video|image] [-N]");

    let mode = "image";
    let num = 10;
    const queryParts = [];

    for (const arg of args) {
      if (arg === "video" || arg === "image") {
        mode = arg;
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
      const doSearch = () =>
        axios.get(`${BASE_URL}/api/search`, {
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

      // Video mode: send thumbnails with numbers, user replies with a number
      // to pick which video to download.
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

    const waitMsg = await message.reply(`⬇️ Downloading video ${choice}...`);
    try {
      const dlUrl = item.download_url.startsWith("http")
        ? item.download_url
        : `${BASE_URL}${item.download_url}`;
      const attachment = await fetchAttachment(dlUrl, `${item.id}.mp4`);
      await message.reply({ attachment });
    } catch (e) {
      const reason = await readErrorBody(e) || e.message;
      await message.reply(`❌ Failed to download video ${choice}.\nReason: ${reason}`);
    } finally {
      if (waitMsg && waitMsg.messageID) {
        try { api.unsendMessage(waitMsg.messageID); } catch {}
      }
    }
  }
};
