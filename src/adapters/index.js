// Adapter manifest. Order is irrelevant; the registry validates every entry and
// refuses to boot on a capability hole.
//
// Adding a platform = add one module here + restart. No image rebuild, no paas
// change, no gate list to remember (the gate walks this array).
import wecomBot from "./wecom-bot.js";
import telegram from "./telegram.js";
import slack from "./slack.js";
import feishu from "./feishu.js";
import wecom from "./wecom.js";
import wechatOa from "./wechat-oa.js";
import wecomWebhook from "./wecom-webhook.js";
import chatwoot from "./chatwoot.js";
import mattermost from "./mattermost.js";

export const adapters = [wecomBot, telegram, slack, feishu, wecom, wechatOa, wecomWebhook, chatwoot, mattermost];
