# pi-speaker

为 pi-coding-agent 提供读屏能力的扩展（MVP）。

## 功能

- 朗读 assistant 回复与工具输出
- 支持 summary/full/off 模式
- 快捷键与 `/speak` 命令控制
- macOS / Linux / Windows TTS 适配

## 安装（开发模式）

```bash
# 方式 1：直接放到项目
mkdir -p .pi/extensions
cp -r extensions/pi-speaker .pi/extensions/

# 方式 2：通过 pi package
pi install https://github.com/mlj1991/pi-speaker
```

## 使用

### 快捷键（默认）

- `ctrl+shift+s`：开关读屏
- `alt+shift+s`：循环模式（off → summary → full）
- `ctrl+.`：停止朗读
- `alt+r`：重播

### 命令

```
/speak on|off|summary|full
/speak tools off|summary|full
/speak rate <num>
/speak volume <num>
/speak voice <name>
/speak stop | /speak repeat
/speak reload
/speak save [project|global]
```

## 配置

支持 `~/.pi/agent/settings.json` 和 `.pi/settings.json`：

```json
{
  "piSpeaker": {
    "mode": "summary",
    "readToolResults": "summary",
    "voice": "Ting-Ting",
    "rate": 200,
    "volume": 80,
    "interruptOnNewMessage": true,
    "maxSentenceLength": 200
  }
}
```

## 文档

- 方案设计：`docs/tech-design.md`
