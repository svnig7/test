/**
 * Auto Caption Bot — Cloudflare Worker
 * Watches channel posts, rewrites captions (prefix/suffix + find-replace/
 * remove rules), preserving entities (bold/links/expandable blockquote/etc).
 * Open to any user in private chat, gated by force-subscribe.
 *
 * Bindings required (wrangler.toml):
 *   - KV:      CAPTION_KV
 *   - Secrets: BOT_TOKEN, WEBHOOK_SECRET
 */

const DEFAULT_SETTINGS = {
  prefix: "",
  suffix: "",
  rules: [],
  removes: [],
  forcesub: "",
  metaFormat: true, // style captions that already have the 📺 Title / 🆔 TMDB ID layout
};

function getFilename(post) {
  return post.document?.file_name || post.video?.file_name || null;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Filename in <code>, metadata block in an expandable <blockquote>. */
function formatMetaCaption(filename, metadata) {
  return `<code>${escapeHTML(filename)}</code>\n\n<blockquote expandable>${escapeHTML(metadata)}</blockquote>`;
}

/** Plain find/replace + remove rules applied to raw text before HTML-escaping. */
function applyTextRules(text, settings) {
  for (const r of settings.rules) {
    if (r.find) text = text.split(r.find).join(r.replace);
  }
  for (const r of settings.removes) {
    if (r) text = text.split(r).join("");
  }
  return text;
}

// ---------- Telegram helpers ----------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ---------- Settings (KV) ----------

async function getSettings(env) {
  const raw = await env.CAPTION_KV.get("settings", "json");
  return raw ? { ...DEFAULT_SETTINGS, ...raw } : { ...DEFAULT_SETTINGS };
}

async function saveSettings(env, settings) {
  await env.CAPTION_KV.put("settings", JSON.stringify(settings));
}

// ---------- Caption rewriting (entity-safe) ----------

/**
 * Applies find/replace and remove rules, then prefix/suffix, to a caption,
 * adjusting caption_entities offsets so formatting (bold, links, expandable
 * blockquote, etc.) survives. Entities that overlap a replaced span are
 * dropped (can't be reliably preserved); everything else is shifted.
 */
function applyRules(text, entities, settings) {
  text = text || "";
  entities = entities ? entities.map((e) => ({ ...e })) : [];

  const allRules = [
    ...settings.rules,
    ...settings.removes.map((find) => ({ find, replace: "" })),
  ];

  for (const rule of allRules) {
    const { find, replace } = rule;
    if (!find) continue;
    let searchFrom = 0;
    while (true) {
      const pos = text.indexOf(find, searchFrom);
      if (pos === -1) break;
      const end = pos + find.length;
      const delta = replace.length - find.length;

      const next = [];
      for (const e of entities) {
        const eEnd = e.offset + e.length;
        if (eEnd <= pos) {
          next.push(e);
        } else if (e.offset >= end) {
          next.push({ ...e, offset: e.offset + delta });
        }
        // else: overlaps the replaced span -> dropped
      }
      entities = next;
      text = text.slice(0, pos) + replace + text.slice(end);
      searchFrom = pos + replace.length;
    }
  }

  if (settings.prefix) {
    const p = settings.prefix + "\n";
    entities = entities.map((e) => ({ ...e, offset: e.offset + p.length }));
    text = p + text;
  }

  if (settings.suffix) {
    text = text + "\n" + settings.suffix;
  }

  return { text, entities };
}

// ---------- Force-subscribe ----------

async function isSubscribed(env, userId) {
  const settings = await getSettings(env);
  if (!settings.forcesub) return true;
  const res = await tg(env, "getChatMember", { chat_id: settings.forcesub, user_id: userId });
  if (!res.ok) return true; // fail open (bot not admin in fsub channel yet, etc.)
  return !["left", "kicked"].includes(res.result.status);
}

async function sendForceSubPrompt(env, chatId) {
  const settings = await getSettings(env);
  const channel = settings.forcesub.replace(/^@/, "");
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "You need to join our channel to use this bot.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "Join Channel", url: `https://t.me/${channel}` }],
        [{ text: "I've Joined ✅", callback_data: "check_sub" }],
      ],
    },
  });
}

// ---------- Command handling (private chat, open to any user) ----------

async function handleCommand(env, message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || "").trim();
  const [cmdRaw, ...rest] = text.split(" ");
  const cmd = cmdRaw.split("@")[0];
  const arg = rest.join(" ").trim();

  // Force-sub gate applies to every command, not just /start.
  if (!(await isSubscribed(env, userId))) {
    await sendForceSubPrompt(env, chatId);
    return;
  }

  if (cmd === "/start") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "Auto Caption Bot is running.\n\n" +
        "Add me as admin (with edit-messages permission) to a channel and I'll " +
        "rewrite every new post's caption automatically.\n\n" +
        "Send /help for commands.",
    });
    return;
  }

  if (cmd === "/help") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "Commands:\n" +
        "/setprefix <text>\n/delprefix\n" +
        "/setsuffix <text>\n/delsuffix\n" +
        "/addreplace <find> => <replace>\n" +
        "/delreplace <index>\n" +
        "/listrules\n" +
        "/addremove <text>\n" +
        "/delremove <index>\n" +
        "/listremove\n" +
        "/setforcesub <@channel>\n/delforcesub\n" +
        "/metaformat <on|off>\n" +
        "/settings",
    });
    return;
  }

  const settings = await getSettings(env);

  switch (cmd) {
    case "/setprefix":
      if (!arg) return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /setprefix <text>" });
      settings.prefix = arg;
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Prefix set:\n${arg}` });
      break;

    case "/delprefix":
      settings.prefix = "";
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: "Prefix removed." });
      break;

    case "/setsuffix":
      if (!arg) return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /setsuffix <text>" });
      settings.suffix = arg;
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Suffix set:\n${arg}` });
      break;

    case "/delsuffix":
      settings.suffix = "";
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: "Suffix removed." });
      break;

    case "/addreplace": {
      const [find, replace] = arg.split("=>").map((s) => s.trim());
      if (!find || replace === undefined) {
        return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /addreplace find => replace" });
      }
      settings.rules.push({ find, replace });
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Rule added: "${find}" → "${replace}"` });
      break;
    }

    case "/delreplace": {
      const idx = parseInt(arg, 10);
      if (isNaN(idx) || idx < 1 || idx > settings.rules.length) {
        return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /delreplace <index> (see /listrules)" });
      }
      const removed = settings.rules.splice(idx - 1, 1)[0];
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Removed: "${removed.find}" → "${removed.replace}"` });
      break;
    }

    case "/listrules": {
      if (!settings.rules.length) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "No replace rules set." });
        break;
      }
      const list = settings.rules.map((r, i) => `${i + 1}. "${r.find}" → "${r.replace}"`).join("\n");
      await tg(env, "sendMessage", { chat_id: chatId, text: list });
      break;
    }

    case "/addremove":
      if (!arg) return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /addremove <text>" });
      settings.removes.push(arg);
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Will now strip: "${arg}"` });
      break;

    case "/delremove": {
      const idx = parseInt(arg, 10);
      if (isNaN(idx) || idx < 1 || idx > settings.removes.length) {
        return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /delremove <index> (see /listremove)" });
      }
      const removed = settings.removes.splice(idx - 1, 1)[0];
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Removed rule: "${removed}"` });
      break;
    }

    case "/listremove": {
      if (!settings.removes.length) {
        await tg(env, "sendMessage", { chat_id: chatId, text: "No remove rules set." });
        break;
      }
      const list = settings.removes.map((r, i) => `${i + 1}. "${r}"`).join("\n");
      await tg(env, "sendMessage", { chat_id: chatId, text: list });
      break;
    }

    case "/setforcesub":
      if (!arg) return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /setforcesub <@channel>" });
      settings.forcesub = arg;
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: `Force-sub channel set to ${arg}` });
      break;

    case "/delforcesub":
      settings.forcesub = "";
      await saveSettings(env, settings);
      await tg(env, "sendMessage", { chat_id: chatId, text: "Force-sub disabled." });
      break;

    case "/metaformat":
      if (!["on", "off"].includes(arg)) {
        return tg(env, "sendMessage", { chat_id: chatId, text: "Usage: /metaformat <on|off>" });
      }
      settings.metaFormat = arg === "on";
      await saveSettings(env, settings);
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: `Metadata formatting ${settings.metaFormat ? "enabled" : "disabled"}.`,
      });
      break;

    case "/settings":
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          `Prefix: ${settings.prefix || "—"}\n` +
          `Suffix: ${settings.suffix || "—"}\n` +
          `Rules: ${settings.rules.length}\n` +
          `Remove rules: ${settings.removes.length}\n` +
          `Force-sub: ${settings.forcesub || "off"}\n` +
          `Meta format: ${settings.metaFormat ? "on" : "off"}`,
      });
      break;

    default:
      break;
  }
}

// ---------- Channel post handling ----------

async function handleChannelPost(env, post) {
  const settings = await getSettings(env);

  if (settings.metaFormat && post.caption && post.caption.includes("📺 Title : ")) {
    const filename = getFilename(post);
    if (filename) {
      const metadata = post.caption.slice(post.caption.indexOf("📺 Title : ")).trim();
      const fname = applyTextRules(filename, settings);
      const meta = applyTextRules(metadata, settings);
      let body = formatMetaCaption(fname, meta);
      if (settings.prefix) body = escapeHTML(settings.prefix) + "\n" + body;
      if (settings.suffix) body = body + "\n" + escapeHTML(settings.suffix);

      if (body !== post.caption) {
        await tg(env, "editMessageCaption", {
          chat_id: post.chat.id,
          message_id: post.message_id,
          caption: body,
          parse_mode: "HTML",
        });
      }
      return;
    }
  }

  // General case: no metadata layout detected — prefix/suffix/rules on the
  // caption as-is, preserving whatever entities it already has.
  if (post.caption === undefined) return;
  if (!settings.prefix && !settings.suffix && settings.rules.length === 0 && settings.removes.length === 0) return;

  const { text, entities } = applyRules(post.caption, post.caption_entities, settings);
  if (text === post.caption) return;

  await tg(env, "editMessageCaption", {
    chat_id: post.chat.id,
    message_id: post.message_id,
    caption: text,
    caption_entities: entities,
  });
}

// ---------- Webhook entry ----------

async function handleUpdate(env, update) {
  if (update.channel_post) {
    await handleChannelPost(env, update.channel_post);
    return;
  }
  if (update.callback_query && update.callback_query.data === "check_sub") {
    const cq = update.callback_query;
    const ok = await isSubscribed(env, cq.from.id);
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: ok ? "You're in! Send your command again." : "Still not joined.",
      show_alert: true,
    });
    return;
  }
  if (update.message && update.message.chat.type === "private" && update.message.text?.startsWith("/")) {
    await handleCommand(env, update.message);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Auto Caption Bot is running.", { status: 200 });
    }

    // One-time setup helper: /set-webhook?secret=<WEBHOOK_SECRET>
    if (request.method === "GET" && url.pathname === "/set-webhook") {
      if (url.searchParams.get("secret") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const webhookUrl = `${url.origin}/webhook`;
      const res = await tg(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "channel_post", "callback_query"],
      });
      return new Response(JSON.stringify(res), { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secret !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        await handleUpdate(env, update);
      } catch (err) {
        console.error(err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};
