const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const API_BASE = "https://qwen-api-gq76.onrender.com/text2img";

module.exports = {
  config: {
    name: "text2img",
    aliases: ["t2i"],
    version: "1.1.0",
    author: "rX",
    countDown: 30,
    role: 0,
    description: {
      en: "Generate an image from a text prompt (Qwen API)"
    },
    category: "ai",
    guide: {
      en: "{pn} <prompt>\nExample: {pn} a cat flying over Dhaka at sunset"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const prompt = args.join(" ").trim();

    if (!prompt) {
      return message.reply(
        "⚠️ Please provide a prompt. Example: text2img a cat flying over Dhaka at sunset"
      );
    }

    api.setMessageReaction("🐣", event.messageID, () => {}, true);

    let filePath = null;

    try {
      const params = new URLSearchParams();
      params.set("prompt", prompt);

      const requestURL = `${API_BASE}?${params.toString()}`;
      console.log("🔗 Request URL:", requestURL);

      const res = await axios.get(requestURL, { timeout: 120000 });
      const data = res.data;
      const finalImageURL =
        data && data.success && typeof data.imageUrl === "string" ? data.imageUrl : null;

      if (!finalImageURL) {
        const errMsg = (data && (data.error || data.message)) || "Unknown reason";
        console.log("❌ Failed. success:", data && data.success, "| reason:", errMsg);
        api.setMessageReaction("⚠️", event.messageID, () => {}, true);
        return message.reply(`❌ API Error: ${errMsg}`);
      }

      const cacheDir = path.join(__dirname, "cache");
      fs.ensureDirSync(cacheDir);
      filePath = path.join(
        cacheDir,
        `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
      );

      const imageResponse = await axios.get(finalImageURL, {
        responseType: "stream",
        timeout: 60000
      });

      const writer = fs.createWriteStream(filePath);

      await new Promise((resolve, reject) => {
        imageResponse.data.on("error", reject);
        writer.on("finish", resolve);
        writer.on("error", reject);
        imageResponse.data.pipe(writer);
      });

      const sentPath = filePath;
      filePath = null; // ownership goes to the send callback

      api.setMessageReaction("🧃", event.messageID, () => {}, true);
      message.reply(
        {
          body: "> 🎀 𝐃𝐨𝐧𝐞",
          attachment: fs.createReadStream(sentPath)
        },
        () => fs.unlink(sentPath, () => {})
      );
    } catch (err) {
      if (err.response) {
        console.log("❌ ERROR status:", err.response.status);
        try {
          console.log("❌ ERROR data:", JSON.stringify(err.response.data, null, 2));
        } catch (_) {}
      } else if (err.request) {
        console.log("❌ ERROR: No response received —", err.message);
      } else {
        console.log("❌ ERROR:", err.message);
      }

      if (filePath) fs.unlink(filePath, () => {});

      api.setMessageReaction("❌", event.messageID, () => {}, true);
      message.reply("❌ Error while generating the image.");
    }
  }
};
