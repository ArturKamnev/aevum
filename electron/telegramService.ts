import { BrowserWindow, app } from "electron";
import fs from "node:fs";
import path from "node:path";
import keytar from "keytar";

export type TelegramBridgeStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "invalid-token"
  | "not-paired"
  | "webhook-conflict"
  | "error";

export type TelegramInteractionMode = "template" | "ai";

export interface TelegramBridgeSettings {
  enabled: boolean;
  language: "en" | "ru";
  useDefaultAI: boolean;
  aiProvider: "ollama" | "openrouter";
  localModel: string;
  cloudModel: string;
}

export interface TelegramStatusSnapshot {
  status: TelegramBridgeStatus;
  enabled: boolean;
  hasToken: boolean;
  bot?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  pairedChat?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  pairingCode?: string;
  pairingExpiresAt?: string;
  interactionMode: TelegramInteractionMode;
  message?: string;
}

interface TelegramStoredState {
  offset: number;
  interactionMode?: TelegramInteractionMode;
  pairedChat?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  bot?: {
    id: number;
    username?: string;
    firstName?: string;
  };
}

interface TelegramMessageRequest {
  id: string;
  chatId: number;
  messageId: number;
  text: string;
  interactionMode: TelegramInteractionMode;
}

interface TelegramDecisionRequest {
  id: string;
  proposalId: string;
  decision: "confirm" | "cancel";
  chatId: number;
}

interface TelegramCallbackRequest {
  id: string;
  chatId: number;
  data: string;
  interactionMode: TelegramInteractionMode;
}

interface TelegramResponseButton {
  text: string;
  callbackData: string;
}

type RendererRequest =
  | { type: "message"; payload: TelegramMessageRequest }
  | { type: "decision"; payload: TelegramDecisionRequest }
  | { type: "callback"; payload: TelegramCallbackRequest };

type RendererResponse =
  | { ok: true; kind: "message"; text: string }
  | { ok: true; kind: "buttons"; text: string; buttons: TelegramResponseButton[][] }
  | { ok: true; kind: "proposal"; proposalId: string; text: string }
  | { ok: false; text: string };

const serviceName = "Aevum";
const tokenAccount = "telegram-bot-token";
const apiBase = "https://api.telegram.org";
const pairingTtlMs = 10 * 60_000;

export class TelegramBridge {
  private settings: TelegramBridgeSettings = {
    enabled: false,
    language: "en",
    useDefaultAI: true,
    aiProvider: "ollama",
    localModel: "qwen3.5:9b",
    cloudModel: "openrouter/free",
  };
  private state: TelegramStoredState = { offset: 0 };
  private status: TelegramBridgeStatus = "disabled";
  private statusMessage = "";
  private pairingCode = "";
  private pairingExpiresAt = 0;
  private pollAbort: AbortController | null = null;
  private isPolling = false;
  private rendererReady = false;
  private queuedRendererRequests: RendererRequest[] = [];
  private pendingRendererResponses = new Map<string, (value: RendererResponse) => void>();

  constructor(private readonly broadcast: (channel: string, payload: unknown) => void) {
    this.state = this.loadState();
  }

  async setSettings(settings: Partial<TelegramBridgeSettings>) {
    this.settings = { ...this.settings, ...settings };
    if (!this.settings.enabled) {
      this.stopPolling();
      this.status = "disabled";
      this.broadcastStatus();
      return this.getStatusAsync();
    }

    await this.ensurePolling();
    return this.getStatusAsync();
  }

  async connectToken(value: unknown) {
    const token = typeof value === "string" ? value.trim() : "";
    this.status = "connecting";
    this.statusMessage = "";
    this.broadcastStatus();

    if (!isTelegramToken(token)) {
      this.status = "invalid-token";
      this.statusMessage = "Invalid Telegram bot token.";
      this.broadcastStatus();
      return { ok: false, ...(await this.getStatusAsync()) };
    }

    const bot = await this.telegramRequestWithToken(token, "getMe", {});
    if (!bot.ok || !isRecord(bot.result)) {
      this.status = "invalid-token";
      this.statusMessage = readTelegramDescription(bot) || "Telegram rejected this bot token.";
      this.broadcastStatus();
      return { ok: false, ...(await this.getStatusAsync()) };
    }

    await keytar.setPassword(serviceName, tokenAccount, token);
    this.state.bot = {
      id: typeof bot.result.id === "number" ? bot.result.id : 0,
      username: typeof bot.result.username === "string" ? bot.result.username : undefined,
      firstName: typeof bot.result.first_name === "string" ? bot.result.first_name : undefined,
    };
    this.state.pairedChat = undefined;
    this.state.interactionMode = "template";
    this.state.offset = 0;
    this.saveState();
    this.ensurePairingCode();
    await this.ensurePolling();
    this.broadcastStatus();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  async disconnect() {
    this.stopPolling();
    await keytar.deletePassword(serviceName, tokenAccount);
    this.state = { offset: 0 };
    this.pairingCode = "";
    this.pairingExpiresAt = 0;
    this.status = "disabled";
    this.statusMessage = "";
    this.saveState();
    this.broadcastStatus();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  async unpair() {
    this.state.pairedChat = undefined;
    this.state.interactionMode = "template";
    this.ensurePairingCode(true);
    this.saveState();
    if (this.settings.enabled && await this.hasToken()) this.status = "not-paired";
    this.broadcastStatus();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  async reconnectPolling() {
    const result = await this.telegramRequest("deleteWebhook", { drop_pending_updates: false });
    if (!result.ok) {
      this.status = "error";
      this.statusMessage = readTelegramDescription(result) || "Could not clear Telegram webhook.";
      this.broadcastStatus();
      return { ok: false, ...(await this.getStatusAsync()) };
    }
    await this.ensurePolling();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  getStatus(): TelegramStatusSnapshot {
    const hasPairing = Boolean(this.pairingCode && this.pairingExpiresAt > Date.now() && !this.state.pairedChat);
    return {
      status: this.status,
      enabled: this.settings.enabled,
      hasToken: false,
      bot: this.state.bot,
      pairedChat: this.state.pairedChat,
      pairingCode: hasPairing ? this.pairingCode : undefined,
      pairingExpiresAt: hasPairing ? new Date(this.pairingExpiresAt).toISOString() : undefined,
      interactionMode: this.currentInteractionMode(),
      message: this.statusMessage || undefined,
    };
  }

  async getStatusAsync() {
    return { ...this.getStatus(), hasToken: await this.hasToken() };
  }

  markRendererReady() {
    this.rendererReady = true;
    const queued = [...this.queuedRendererRequests];
    this.queuedRendererRequests = [];
    queued.forEach((request) => this.sendRendererRequest(request));
    return { ok: true };
  }

  handleRendererResponse(value: unknown) {
    if (!isRecord(value) || typeof value.id !== "string") return { ok: false };
    const resolver = this.pendingRendererResponses.get(value.id);
    if (!resolver) return { ok: false };
    this.pendingRendererResponses.delete(value.id);
    resolver(readRendererResponse(value.response));
    return { ok: true };
  }

  stop() {
    this.stopPolling();
    for (const resolve of this.pendingRendererResponses.values()) {
      resolve({ ok: false, text: this.copy("telegram.error.rendererUnavailable") });
    }
    this.pendingRendererResponses.clear();
  }

  private async ensurePolling() {
    if (!this.settings.enabled) return;
    const token = await this.getToken();
    if (!token) {
      this.status = "disabled";
      this.broadcastStatus();
      return;
    }

    const webhookInfo = await this.telegramRequest("getWebhookInfo", {});
    if (webhookInfo.ok && isRecord(webhookInfo.result) && typeof webhookInfo.result.url === "string" && webhookInfo.result.url.trim()) {
      this.stopPolling();
      this.status = "webhook-conflict";
      this.statusMessage = "Telegram webhook is configured. Long polling is paused.";
      this.broadcastStatus();
      return;
    }

    if (!this.state.pairedChat) {
      this.ensurePairingCode();
      this.status = "not-paired";
      this.broadcastStatus();
    } else {
      this.status = "connected";
      this.broadcastStatus();
    }

    if (!this.isPolling) {
      void this.pollLoop();
    }
  }

  private async pollLoop() {
    if (this.isPolling) return;
    this.isPolling = true;
    this.pollAbort = new AbortController();

    while (this.settings.enabled && this.pollAbort && !this.pollAbort.signal.aborted) {
      try {
        const response = await this.telegramRequest("getUpdates", {
          offset: this.state.offset || undefined,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        }, this.pollAbort.signal);

        if (!response.ok) {
          this.status = response.error_code === 409 ? "webhook-conflict" : "error";
          this.statusMessage = readTelegramDescription(response) || "Telegram polling failed.";
          this.broadcastStatus();
          await delay(3000);
          continue;
        }

        if (Array.isArray(response.result)) {
          for (const update of response.result) {
            await this.handleUpdate(update);
            const updateId = isRecord(update) && typeof update.update_id === "number" ? update.update_id : null;
            if (updateId !== null) {
              this.state.offset = Math.max(this.state.offset, updateId + 1);
              this.saveState();
            }
          }
        }
      } catch (error) {
        if (this.pollAbort?.signal.aborted) break;
        this.status = "error";
        this.statusMessage = error instanceof Error ? sanitizeMessage(error.message) : "Telegram polling failed.";
        this.broadcastStatus();
        await delay(3000);
      }
    }

    this.isPolling = false;
  }

  private async handleUpdate(update: unknown) {
    if (!isRecord(update)) return;
    if (isRecord(update.callback_query)) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    if (isRecord(update.message)) {
      await this.handleMessage(update.message);
    }
  }

  private async handleMessage(message: Record<string, unknown>) {
    if (!isRecord(message.chat) || message.chat.type !== "private" || typeof message.chat.id !== "number") return;
    if (typeof message.text !== "string" || typeof message.message_id !== "number") return;
    const chatId = message.chat.id;
    const text = message.text.trim();
    if (!text) return;

    if (!this.state.pairedChat) {
      this.ensurePairingCode();
      if (this.isPairingCode(text)) {
        this.state.pairedChat = {
          id: chatId,
          username: isRecord(message.from) && typeof message.from.username === "string" ? message.from.username : undefined,
          firstName: isRecord(message.from) && typeof message.from.first_name === "string" ? message.from.first_name : undefined,
        };
        this.state.interactionMode = "template";
        this.pairingCode = "";
        this.pairingExpiresAt = 0;
        this.status = "connected";
        this.saveState();
        this.broadcastStatus();
        await this.sendMessage(chatId, this.copy("telegram.reply.paired"), this.templateMenuMarkup());
      } else {
        await this.sendMessage(chatId, this.copy("telegram.reply.pairRequired"));
      }
      return;
    }

    if (this.state.pairedChat.id !== chatId) {
      await this.sendMessage(chatId, this.copy("telegram.reply.unauthorized"));
      return;
    }

    const request: TelegramMessageRequest = {
      id: createRequestId(),
      chatId,
      messageId: message.message_id,
      text,
      interactionMode: this.currentInteractionMode(),
    };
    const response = await this.requestRenderer({ type: "message", payload: request });
    await this.deliverRendererResponse(chatId, response);
  }

  private async handleCallbackQuery(query: Record<string, unknown>) {
    const callbackId = typeof query.id === "string" ? query.id : "";
    const data = typeof query.data === "string" ? query.data : "";
    const chat = isRecord(query.message) && isRecord(query.message.chat) ? query.message.chat : null;
    const chatId = chat && typeof chat.id === "number" ? chat.id : null;

    if (!callbackId || !chatId) return;
    if (!this.state.pairedChat || this.state.pairedChat.id !== chatId) {
      await this.answerCallback(callbackId, this.copy("telegram.reply.unauthorized"));
      return;
    }

    const decisionMatch = /^tg:(confirm|cancel):([A-Za-z0-9_-]{8,80})$/.exec(data);
    if (decisionMatch) {
      await this.answerCallback(callbackId, decisionMatch[1] === "confirm" ? this.copy("telegram.callback.confirming") : this.copy("telegram.callback.canceling"));
      await this.editReplyMarkup(query.message, undefined);

      const response = await this.requestRenderer({
        type: "decision",
        payload: {
          id: createRequestId(),
          proposalId: decisionMatch[2],
          decision: decisionMatch[1] === "confirm" ? "confirm" : "cancel",
          chatId,
        },
      });
      await this.deliverRendererResponse(chatId, response);
      return;
    }

    const modeMatch = /^tg:mode:(template|ai)$/.exec(data);
    if (modeMatch) {
      this.state.interactionMode = modeMatch[1] === "ai" ? "ai" : "template";
      this.saveState();
      this.broadcastStatus();
      await this.answerCallback(callbackId, this.copy(modeMatch[1] === "ai" ? "telegram.callback.aiMode" : "telegram.callback.templateMode"));
      await this.editReplyMarkup(query.message, undefined);
      const response = await this.requestRenderer({
        type: "callback",
        payload: {
          id: createRequestId(),
          chatId,
          data,
          interactionMode: this.currentInteractionMode(),
        },
      });
      await this.deliverRendererResponse(chatId, response);
      return;
    }

    if (!isSafeTelegramCallbackData(data)) {
      await this.answerCallback(callbackId, this.copy("telegram.error.expired"));
      return;
    }

    await this.answerCallback(callbackId, this.copy("telegram.callback.opening"));
    await this.editReplyMarkup(query.message, undefined);
    const response = await this.requestRenderer({
      type: "callback",
      payload: {
        id: createRequestId(),
        chatId,
        data,
        interactionMode: this.currentInteractionMode(),
      },
    });
    await this.deliverRendererResponse(chatId, response);
  }

  private async deliverRendererResponse(chatId: number, response: RendererResponse) {
    if (!response.ok || response.kind === "message") {
      await this.sendMessage(chatId, sanitizeTelegramText(response.text));
      return;
    }
    if (response.kind === "buttons") {
      await this.sendMessage(chatId, sanitizeTelegramText(response.text), {
        inline_keyboard: response.buttons.map((row) => row.map((button) => ({
          text: sanitizeTelegramText(button.text).slice(0, 64),
          callback_data: button.callbackData,
        }))),
      });
      return;
    }
    await this.sendMessage(chatId, sanitizeTelegramText(response.text), {
      inline_keyboard: [[
        { text: this.copy("telegram.button.confirm"), callback_data: `tg:confirm:${response.proposalId}` },
        { text: this.copy("telegram.button.cancel"), callback_data: `tg:cancel:${response.proposalId}` },
      ]],
    });
  }

  private async requestRenderer(request: RendererRequest): Promise<RendererResponse> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRendererResponses.delete(request.payload.id);
        resolve({ ok: false, text: this.copy("telegram.error.rendererTimeout") });
      }, 45_000);
      this.pendingRendererResponses.set(request.payload.id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
      if (this.rendererReady && BrowserWindow.getAllWindows().length > 0) {
        this.sendRendererRequest(request);
      } else {
        this.queuedRendererRequests.push(request);
      }
    });
  }

  private sendRendererRequest(request: RendererRequest) {
    const channel = request.type === "message"
      ? "telegram:message-request"
      : request.type === "decision"
        ? "telegram:decision-request"
        : "telegram:callback-request";
    this.broadcast(channel, request.payload);
  }

  private async sendMessage(chatId: number, text: string, replyMarkup?: unknown) {
    await this.telegramRequest("sendMessage", {
      chat_id: chatId,
      text: sanitizeTelegramText(text),
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
  }

  private async answerCallback(callbackQueryId: string, text: string) {
    await this.telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: sanitizeTelegramText(text).slice(0, 180),
      show_alert: false,
    });
  }

  private async editReplyMarkup(message: unknown, replyMarkup: unknown) {
    if (!isRecord(message) || !isRecord(message.chat) || typeof message.chat.id !== "number" || typeof message.message_id !== "number") return;
    await this.telegramRequest("editMessageReplyMarkup", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }

  private stopPolling() {
    this.pollAbort?.abort();
    this.pollAbort = null;
  }

  private currentInteractionMode(): TelegramInteractionMode {
    return this.state.interactionMode === "ai" ? "ai" : "template";
  }

  private templateMenuMarkup() {
    return {
      inline_keyboard: [
        [
          { text: this.copy("telegram.menu.today"), callback_data: "tg:today" },
          { text: this.copy("telegram.menu.upcoming"), callback_data: "tg:upcoming" },
        ],
        [{ text: this.copy("telegram.menu.create"), callback_data: "tg:create" }],
        [{ text: this.copy("telegram.menu.aiMode"), callback_data: "tg:mode:ai" }],
      ],
    };
  }

  private ensurePairingCode(force = false) {
    if (!force && this.pairingCode && this.pairingExpiresAt > Date.now()) return;
    this.pairingCode = createPairingCode();
    this.pairingExpiresAt = Date.now() + pairingTtlMs;
  }

  private isPairingCode(value: string) {
    return Boolean(this.pairingCode && this.pairingExpiresAt > Date.now() && value.trim().toUpperCase() === this.pairingCode);
  }

  private async telegramRequest(method: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const token = await this.getToken();
    if (!token) return { ok: false, error_code: 401, description: "Telegram bot token is not configured." };
    return this.telegramRequestWithToken(token, method, body, signal);
  }

  private async telegramRequestWithToken(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return (await response.json()) as { ok: boolean; result?: unknown; error_code?: number; description?: string };
  }

  private async getToken() {
    return keytar.getPassword(serviceName, tokenAccount);
  }

  private async hasToken() {
    return Boolean(await this.getToken());
  }

  private loadState(): TelegramStoredState {
    try {
      const file = this.statePath();
      if (!fs.existsSync(file)) return { offset: 0 };
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!isRecord(parsed)) return { offset: 0 };
      return {
        offset: typeof parsed.offset === "number" ? parsed.offset : 0,
        interactionMode: parsed.interactionMode === "ai" ? "ai" : "template",
        pairedChat: readStoredChat(parsed.pairedChat),
        bot: readStoredBot(parsed.bot),
      };
    } catch {
      return { offset: 0 };
    }
  }

  private saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
      fs.writeFileSync(this.statePath(), JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      // Non-critical; polling can continue, but duplicates may be possible after restart.
    }
  }

  private statePath() {
    return path.join(app.getPath("userData"), "telegram-bridge-state.json");
  }

  private broadcastStatus() {
    void this.getStatusAsync().then((status) => this.broadcast("telegram:status", status));
  }

  private copy(key: string) {
    const ru = this.settings.language === "ru";
    const messages: Record<string, [string, string]> = {
      "telegram.reply.paired": ["Telegram Assistant is paired with Aevum. Template Mode is active.", "Telegram-ассистент подключен к Aevum. Обычный режим активен."],
      "telegram.reply.pairRequired": ["Open Aevum Settings and send the current pairing code here.", "Откройте настройки Aevum и отправьте сюда текущий код привязки."],
      "telegram.reply.unauthorized": ["This chat is not authorized for this Aevum bot.", "Этот чат не авторизован для этого бота Aevum."],
      "telegram.button.confirm": ["Confirm", "Подтвердить"],
      "telegram.button.cancel": ["Cancel", "Отменить"],
      "telegram.callback.confirming": ["Applying...", "Применяю..."],
      "telegram.callback.canceling": ["Canceling...", "Отменяю..."],
      "telegram.callback.opening": ["Opening...", "Открываю..."],
      "telegram.callback.aiMode": ["AI Mode enabled.", "Режим ИИ включен."],
      "telegram.callback.templateMode": ["Template Mode enabled.", "Обычный режим включен."],
      "telegram.menu.today": ["Today", "Сегодня"],
      "telegram.menu.upcoming": ["Upcoming", "Предстоящее"],
      "telegram.menu.create": ["Create task", "Создать задачу"],
      "telegram.menu.aiMode": ["Switch to AI Mode", "Переключиться в режим ИИ"],
      "telegram.error.expired": ["This confirmation has expired.", "Это подтверждение истекло."],
      "telegram.error.rendererUnavailable": ["Aevum is still starting. Try again in a moment.", "Aevum еще запускается. Попробуйте через несколько секунд."],
      "telegram.error.rendererTimeout": ["Aevum did not answer in time. Try again.", "Aevum не ответил вовремя. Попробуйте снова."],
    };
    return messages[key]?.[ru ? 1 : 0] ?? key;
  }
}

function readRendererResponse(value: unknown): RendererResponse {
  if (!isRecord(value)) return { ok: false, text: "Aevum returned an unexpected response." };
  if (value.ok === true && value.kind === "proposal" && typeof value.proposalId === "string" && typeof value.text === "string") {
    return { ok: true, kind: "proposal", proposalId: value.proposalId, text: value.text };
  }
  if (value.ok === true && value.kind === "buttons" && typeof value.text === "string" && Array.isArray(value.buttons)) {
    const buttons = readTelegramButtons(value.buttons);
    if (buttons.length) return { ok: true, kind: "buttons", text: value.text, buttons };
  }
  if (value.ok === true && value.kind === "message" && typeof value.text === "string") {
    return { ok: true, kind: "message", text: value.text };
  }
  return { ok: false, text: typeof value.text === "string" ? value.text : "Aevum could not handle that Telegram request." };
}

function readTelegramButtons(value: unknown[]): TelegramResponseButton[][] {
  return value
    .map((row) => Array.isArray(row)
      ? row
        .map((button) => {
          if (!isRecord(button) || typeof button.text !== "string" || typeof button.callbackData !== "string") return null;
          if (!isSafeTelegramCallbackData(button.callbackData)) return null;
          return { text: button.text, callbackData: button.callbackData };
        })
        .filter((button): button is TelegramResponseButton => Boolean(button))
      : [])
    .filter((row) => row.length > 0)
    .slice(0, 8);
}

function readStoredChat(value: unknown): TelegramStoredState["pairedChat"] {
  if (!isRecord(value) || typeof value.id !== "number") return undefined;
  return {
    id: value.id,
    username: typeof value.username === "string" ? value.username : undefined,
    firstName: typeof value.firstName === "string" ? value.firstName : undefined,
  };
}

function readStoredBot(value: unknown): TelegramStoredState["bot"] {
  if (!isRecord(value) || typeof value.id !== "number") return undefined;
  return {
    id: value.id,
    username: typeof value.username === "string" ? value.username : undefined,
    firstName: typeof value.firstName === "string" ? value.firstName : undefined,
  };
}

function readTelegramDescription(value: unknown) {
  return isRecord(value) && typeof value.description === "string" ? sanitizeMessage(value.description) : "";
}

function isTelegramToken(value: string) {
  return /^\d{6,20}:[A-Za-z0-9_-]{30,}$/.test(value);
}

function isSafeTelegramCallbackData(value: string) {
  return /^tg:[A-Za-z0-9:_-]{1,90}$/.test(value);
}

function createPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createRequestId() {
  return `tg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeTelegramText(value: string) {
  return sanitizeMessage(value)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-[redacted]")
    .replace(/\b\d{6,20}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/<(?:think|thought|analysis)>[\s\S]*?<\/(?:think|thought|analysis)>/gi, "")
    .replace(/<(?:think|thought|analysis)>[\s\S]*/gi, "")
    .slice(0, 3500);
}

function sanitizeMessage(value: string) {
  return value.replace(/\s+\n/g, "\n").replace(/\n{4,}/g, "\n\n").trim() || "OK";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
