# pi-speaker 技术设计方案

## 1. 目标

- 为视障用户提供可用、低延迟、可中断的读屏体验。
- 兼容 vim / Linux 终端习惯（快捷键、命令、纯键盘操作）。
- 不修改 pi 核心，基于 **pi Extension + TUI API** 实现。

## 2. 功能范围（MVP）

- 朗读 assistant 回复（summary/full/off）。
- 朗读工具结果（summary/full/off）。
- 快捷键控制（toggle / cycle / stop / repeat）。
- `/speak` 命令控制。
- 状态栏显示当前读屏模式。
- 读取/保存 `settings.json` 配置。
- 适配 macOS / Linux / Windows TTS。

## 3. 架构概览

```
pi-speaker (Extension)
 ├── 事件监听 (message_end)
 ├── SpeechQueue (队列 + 中断)
 ├── TTS Adapter (say / espeak / powershell)
 ├── 配置读取/保存
 ├── 命令与快捷键
 └── 状态栏提示
```

## 4. 关键设计点

### 4.1 事件驱动

- `message_end`：assistant/toolResult 结束后朗读。
- 避免 token 级朗读，降低噪音与抖动。

### 4.2 朗读策略

- `summary`：只读前两句并限制最大长度。
- `full`：朗读全文。
- `off`：关闭。

### 4.3 中断策略

- 新消息到来时可中断当前朗读（`interruptOnNewMessage`）。
- `ctrl+.` 立即停止。

### 4.4 TTS 适配

| 平台 | 引擎 | 命令 |
|------|------|------|
| macOS | say | say -v <voice> -r <rate> |
| Linux | espeak | espeak -s <rate> -a <volume> |
| Windows | SAPI | powershell + System.Speech |

## 5. 命令与快捷键

### /speak 命令

- `/speak on|off|summary|full`
- `/speak tools off|summary|full`
- `/speak rate <num>`
- `/speak volume <num>`
- `/speak voice <name>`
- `/speak stop` / `/speak repeat`
- `/speak reload` / `/speak save [project|global]`

### 快捷键（默认）

- `ctrl+shift+s`：开关读屏
- `alt+shift+s`：循环模式（off → summary → full）
- `ctrl+.`：停止朗读
- `alt+r`：重播

## 6. 配置文件

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
    "maxSentenceLength": 200,
    "tts": {
      "macosCommand": "say",
      "linuxCommand": "espeak",
      "windowsCommand": "powershell"
    }
  }
}
```

## 7. MVP 可用性标准

- 朗读完整闭环：assistant/toolResult → TTS → 可中断/可重播
- 快捷键与命令可操作
- 在 macOS/Linux 可运行
- 配置可读写

## 8. 后续演进方向

- streaming 朗读（message_update）
- 语义级摘要
- 错误/警告优先级语音提示
- 与 vim 编辑器模式联动（读回光标行）
