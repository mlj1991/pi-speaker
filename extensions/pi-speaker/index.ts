import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type SpeakerMode = "off" | "summary" | "full";
type ToolReadMode = "off" | "summary" | "full";

type SpeakerConfig = {
  mode: SpeakerMode;
  readToolResults: ToolReadMode;
  voice?: string;
  rate: number;
  volume: number;
  interruptOnNewMessage: boolean;
  maxSentenceLength: number;
  tts?: {
    macosCommand?: string;
    linuxCommand?: string;
    windowsCommand?: string;
  };
};

type SpeakerConfigInput = Partial<SpeakerConfig> & {
  tts?: Partial<SpeakerConfig["tts"]>;
};

type SettingsFile = {
  piSpeaker?: SpeakerConfigInput;
};

const DEFAULT_CONFIG: SpeakerConfig = {
  mode: "summary",
  readToolResults: "summary",
  voice: undefined,
  rate: 200,
  volume: 80,
  interruptOnNewMessage: true,
  maxSentenceLength: 200,
  tts: {
    macosCommand: "say",
    linuxCommand: "espeak",
    windowsCommand: "powershell",
  },
};

const MODE_CYCLE: SpeakerMode[] = ["off", "summary", "full"];
const SHORTCUTS = {
  toggle: "ctrl+shift+s",
  cycleMode: "alt+shift+s",
  stop: "ctrl+.",
  repeat: "alt+r",
} as const;

class SpeechQueue {
  private queue: { text: string; config: SpeakerConfig }[] = [];
  private speaking = false;
  private currentAbort?: AbortController;
  private lastSpoken?: string;
  private lastConfig: SpeakerConfig = { ...DEFAULT_CONFIG, tts: { ...DEFAULT_CONFIG.tts } };

  constructor(private readonly pi: ExtensionAPI) {}

  async speak(text: string, config: SpeakerConfig): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastSpoken = trimmed;
    this.lastConfig = config;
    this.queue.push({ text: trimmed, config });
    if (!this.speaking) {
      void this.drain();
    }
  }

  async repeat(): Promise<void> {
    if (!this.lastSpoken) return;
    await this.speak(this.lastSpoken, this.lastConfig);
  }

  stop(): void {
    this.queue = [];
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
  }

  private async drain(): Promise<void> {
    if (this.speaking) return;
    this.speaking = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.currentAbort = new AbortController();
      try {
        await speakWithAdapter(this.pi, next.text, next.config, this.currentAbort.signal);
      } catch {
        // Ignore adapter errors; continue to next item
      }
      if (this.currentAbort.signal.aborted) {
        break;
      }
    }
    this.speaking = false;
    this.currentAbort = undefined;
  }
}

function getSettingsPaths(ctx: ExtensionContext): { projectPath: string; globalPath: string } {
  const configDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return {
    projectPath: path.join(ctx.cwd, ".pi", "settings.json"),
    globalPath: path.join(configDir, "settings.json"),
  };
}

async function readSettingsFile(filePath: string): Promise<SettingsFile | null> {
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as SettingsFile;
}

async function loadConfig(ctx: ExtensionContext): Promise<SpeakerConfig> {
  const { projectPath, globalPath } = getSettingsPaths(ctx);
  let config: SpeakerConfig = { ...DEFAULT_CONFIG, tts: { ...DEFAULT_CONFIG.tts } };

  try {
    const globalSettings = await readSettingsFile(globalPath);
    if (globalSettings?.piSpeaker) {
      config = mergeConfig(config, globalSettings.piSpeaker);
    }
  } catch (error) {
    ctx.ui.notify(`pi-speaker: 无法读取全局配置: ${(error as Error).message}`, "warning");
  }

  try {
    const projectSettings = await readSettingsFile(projectPath);
    if (projectSettings?.piSpeaker) {
      config = mergeConfig(config, projectSettings.piSpeaker);
    }
  } catch (error) {
    ctx.ui.notify(`pi-speaker: 无法读取项目配置: ${(error as Error).message}`, "warning");
  }

  return config;
}

function mergeConfig(base: SpeakerConfig, override: SpeakerConfigInput): SpeakerConfig {
  return {
    ...base,
    ...override,
    tts: {
      ...base.tts,
      ...override.tts,
    },
  };
}

async function saveConfig(ctx: ExtensionContext, config: SpeakerConfig, scope: "project" | "global"): Promise<void> {
  const { projectPath, globalPath } = getSettingsPaths(ctx);
  const targetPath = scope === "global" ? globalPath : projectPath;
  const existing = (await readSettingsFile(targetPath)) ?? {};
  const updated: SettingsFile = {
    ...existing,
    piSpeaker: {
      ...config,
      tts: { ...config.tts },
    },
  };

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

async function speakWithAdapter(
  pi: ExtensionAPI,
  text: string,
  config: SpeakerConfig,
  signal?: AbortSignal
): Promise<void> {
  const platform = process.platform;
  if (platform === "darwin") {
    const args: string[] = [];
    if (config.voice) args.push("-v", config.voice);
    if (config.rate) args.push("-r", String(Math.round(config.rate)));
    args.push(text);
    await pi.exec(config.tts?.macosCommand ?? "say", args, { signal });
    return;
  }

  if (platform === "win32") {
    const escaped = text.replace(/'/g, "''");
    const rate = Math.max(-10, Math.min(10, Math.round((config.rate - 200) / 20)));
    const volume = Math.max(0, Math.min(100, Math.round(config.volume)));
    const command = [
      "Add-Type -AssemblyName System.Speech;",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      `$synth.Rate = ${rate};`,
      `$synth.Volume = ${volume};`,
      `$synth.Speak('${escaped}');`,
    ].join(" ");
    await pi.exec(config.tts?.windowsCommand ?? "powershell", ["-NoProfile", "-Command", command], { signal });
    return;
  }

  const args: string[] = ["-s", String(Math.round(config.rate))];
  if (config.voice) args.push("-v", config.voice);
  const volume = Math.max(0, Math.min(200, Math.round(config.volume * 2)));
  args.push("-a", String(volume));
  args.push(text);
  await pi.exec(config.tts?.linuxCommand ?? "espeak", args, { signal });
}

function extractText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function sanitizeText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码块已省略）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeText(text: string, maxSentenceLength: number): string {
  const cleaned = sanitizeText(text);
  if (cleaned.length <= maxSentenceLength) return cleaned;
  const sentences = cleaned.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  if (sentences.length === 0) return cleaned.slice(0, maxSentenceLength) + "…";
  const summary = sentences.slice(0, 2).join(" ").trim();
  return summary.length > maxSentenceLength ? summary.slice(0, maxSentenceLength) + "…" : summary;
}

function formatToolSpeech(
  toolName: string,
  isError: boolean,
  contentText: string,
  config: SpeakerConfig
): string {
  const headline = isError ? `工具 ${toolName} 失败。` : `工具 ${toolName} 完成。`;
  if (!contentText) return headline;
  const body =
    config.readToolResults === "full"
      ? sanitizeText(contentText)
      : summarizeText(contentText, config.maxSentenceLength);
  return body ? `${headline} ${body}` : headline;
}

function updateStatus(ctx: ExtensionContext, config: SpeakerConfig): void {
  const label = config.mode === "off" ? "🔇 off" : `🔊 ${config.mode}`;
  ctx.ui.setStatus("pi-speaker", ctx.ui.theme.fg("accent", label));
}

export default function (pi: ExtensionAPI) {
  let config: SpeakerConfig = { ...DEFAULT_CONFIG, tts: { ...DEFAULT_CONFIG.tts } };
  let lastActiveMode: SpeakerMode = "summary";
  const speaker = new SpeechQueue(pi);

  pi.on("session_start", async (_event, ctx) => {
    config = await loadConfig(ctx);
    if (config.mode !== "off") {
      lastActiveMode = config.mode;
    }
    updateStatus(ctx, config);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (config.mode === "off") return;
    const message = event.message as { role?: string; content?: any; toolName?: string; isError?: boolean };
    if (!message?.role) return;

    if (message.role === "assistant") {
      if (config.interruptOnNewMessage) speaker.stop();
      if (config.mode === "off") return;
      const contentText = extractText(message.content ?? []);
      if (!contentText) return;
      const speechText =
        config.mode === "full"
          ? sanitizeText(contentText)
          : summarizeText(contentText, config.maxSentenceLength);
      await speaker.speak(speechText, config);
      return;
    }

    if (message.role === "toolResult") {
      if (config.readToolResults === "off") return;
      if (config.interruptOnNewMessage) speaker.stop();
      const contentText = extractText(message.content ?? []);
      const speechText = formatToolSpeech(
        message.toolName ?? "unknown",
        Boolean(message.isError),
        contentText,
        config
      );
      await speaker.speak(speechText, config);
    }
  });

  pi.registerShortcut(SHORTCUTS.toggle, {
    description: "Toggle pi-speaker",
    handler: async (ctx) => {
      config.mode = config.mode === "off" ? lastActiveMode : "off";
      if (config.mode !== "off") lastActiveMode = config.mode;
      updateStatus(ctx, config);
      ctx.ui.notify(`pi-speaker: ${config.mode}`, "info");
    },
  });

  pi.registerShortcut(SHORTCUTS.cycleMode, {
    description: "Cycle pi-speaker mode",
    handler: async (ctx) => {
      const currentIndex = MODE_CYCLE.indexOf(config.mode);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % MODE_CYCLE.length : 1;
      config.mode = MODE_CYCLE[nextIndex];
      if (config.mode !== "off") lastActiveMode = config.mode;
      updateStatus(ctx, config);
      ctx.ui.notify(`pi-speaker: ${config.mode}`, "info");
    },
  });

  pi.registerShortcut(SHORTCUTS.stop, {
    description: "Stop speaking",
    handler: async (ctx) => {
      speaker.stop();
      ctx.ui.notify("pi-speaker: 已停止朗读", "info");
    },
  });

  pi.registerShortcut(SHORTCUTS.repeat, {
    description: "Repeat last speech",
    handler: async (ctx) => {
      await speaker.repeat();
    },
  });

  pi.registerCommand("speak", {
    description: "pi-speaker 读屏控制",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      if (!input || input === "help") {
        ctx.ui.notify(
          "用法: /speak on|off|summary|full | tools off|summary|full | rate <num> | volume <num> | voice <name> | stop | repeat | save [project|global] | reload",
          "info"
        );
        return;
      }

      const [command, ...rest] = input.split(/\s+/);
      const value = rest.join(" ");

      switch (command) {
        case "on":
          config.mode = lastActiveMode === "off" ? "summary" : lastActiveMode;
          updateStatus(ctx, config);
          ctx.ui.notify(`pi-speaker: ${config.mode}`, "info");
          return;
        case "off":
          config.mode = "off";
          updateStatus(ctx, config);
          ctx.ui.notify("pi-speaker: off", "info");
          return;
        case "summary":
        case "full":
          config.mode = command;
          lastActiveMode = command;
          updateStatus(ctx, config);
          ctx.ui.notify(`pi-speaker: ${config.mode}`, "info");
          return;
        case "tools":
          if (value === "off" || value === "summary" || value === "full") {
            config.readToolResults = value;
            ctx.ui.notify(`pi-speaker: tools ${value}`, "info");
            return;
          }
          ctx.ui.notify("pi-speaker: tools 需要 off|summary|full", "warning");
          return;
        case "rate": {
          const rate = Number(value);
          if (!Number.isFinite(rate)) {
            ctx.ui.notify("pi-speaker: rate 需要数字", "warning");
            return;
          }
          config.rate = Math.max(50, Math.min(400, rate));
          ctx.ui.notify(`pi-speaker: rate ${config.rate}`, "info");
          return;
        }
        case "volume": {
          const volume = Number(value);
          if (!Number.isFinite(volume)) {
            ctx.ui.notify("pi-speaker: volume 需要数字", "warning");
            return;
          }
          config.volume = Math.max(0, Math.min(100, volume));
          ctx.ui.notify(`pi-speaker: volume ${config.volume}`, "info");
          return;
        }
        case "voice":
          config.voice = value || undefined;
          ctx.ui.notify(`pi-speaker: voice ${config.voice ?? "default"}`, "info");
          return;
        case "stop":
        case "pause":
          speaker.stop();
          ctx.ui.notify("pi-speaker: 已停止朗读", "info");
          return;
        case "repeat":
          await speaker.repeat();
          return;
        case "reload":
          config = await loadConfig(ctx);
          if (config.mode !== "off") lastActiveMode = config.mode;
          updateStatus(ctx, config);
          ctx.ui.notify("pi-speaker: 已重新加载配置", "info");
          return;
        case "save": {
          const scope = value === "global" ? "global" : "project";
          try {
            await saveConfig(ctx, config, scope);
            ctx.ui.notify(`pi-speaker: 配置已保存到${scope === "global" ? "全局" : "项目"} settings.json`, "info");
          } catch (error) {
            ctx.ui.notify(`pi-speaker: 保存失败 ${(error as Error).message}`, "error");
          }
          return;
        }
        default:
          ctx.ui.notify("pi-speaker: 未知命令，使用 /speak help", "warning");
      }
    },
  });
}
