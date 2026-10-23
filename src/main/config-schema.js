'use strict';

/**
 * 设置中心表单 schema：渲染进程据此动态生成表单，新增配置项只需改这里。
 * type: text | password | number | textarea | select | switch
 */
const GROUPS = [
  {
    id: 'llm',
    title: '云端 · 对话模型（LLM）',
    desc: '弹幕与互动回复的文本生成，OpenAI 兼容接口',
    fields: [
      { key: 'cloud.deepseek.apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...', wide: true },
      {
        key: 'cloud.deepseek.model', label: '模型', type: 'select', options: [
          { value: 'deepseek-chat', label: 'deepseek-chat（通用，快）' },
          { value: 'deepseek-reasoner', label: 'deepseek-reasoner（推理，慢）' }
        ]
      },
      { key: 'cloud.deepseek.baseUrl', label: 'Base URL', type: 'text', placeholder: 'https://api.deepseek.com', wide: true },
      { key: 'cloud.deepseek.temperature', label: '温度', type: 'number', min: 0, max: 2, step: 0.1 },
      { key: 'cloud.deepseek.maxTokens', label: '最大输出 tokens', type: 'number', min: 32, max: 4096, step: 32 },
      { key: 'cloud.deepseek.timeoutMs', label: '超时（毫秒）', type: 'number', min: 5000, max: 120000, step: 1000 },
      { key: 'cloud.deepseek.systemPrompt', label: '人设提示词', type: 'textarea', full: true, rows: 3 }
    ]
  },
  {
    id: 'tts',
    title: '云端 · 语音合成（edge-tts）',
    desc: '把回复文本转成音频，再交给口型模型驱动',
    fields: [
      { key: 'cloud.tts.pythonPath', label: 'Python 解释器', type: 'text', wide: true },
      {
        key: 'cloud.tts.voice', label: '音色', type: 'select', options: [
          { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声（温柔）' },
          { value: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声（活泼）' },
          { value: 'zh-CN-YunxiNeural', label: '云希 · 男声（年轻）' },
          { value: 'zh-CN-YunjianNeural', label: '云健 · 男声（浑厚）' },
          { value: 'zh-CN-YunyangNeural', label: '云扬 · 男声（播报）' },
          { value: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声' }
        ]
      },
      { key: 'cloud.tts.rate', label: '语速', type: 'text', placeholder: '+0%' },
      { key: 'cloud.tts.volume', label: '音量', type: 'text', placeholder: '+0%' },
      { key: 'cloud.tts.outputDir', label: '输出目录', type: 'text', wide: true }
    ]
  },
  {
    id: 'realtime',
    title: '实时互动 · MuseTalk 口型',
    desc: '直播中即时说话的口型链路，与离线渲染共用 GPU',
    fields: [
      { key: 'muse.pythonPath', label: 'Python 解释器', type: 'text', wide: true },
      { key: 'muse.repoDir', label: 'MuseTalk 仓库目录', type: 'text', wide: true },
      { key: 'muse.avatar', label: '默认形象视频', type: 'text', wide: true },
      {
        key: 'muse.version', label: '模型版本', type: 'select', hint: 'v1.0 需先放置 models/musetalk 权重（当前仅有 v1.5）', options: [
          { value: 'v15', label: 'v1.5（推荐）' },
          { value: 'v10', label: 'v1.0（权重未下载）' }
        ]
      },
      { key: 'muse.batchSize', label: '批大小', type: 'number', min: 1, max: 16 },
      { key: 'muse.fps', label: '输出帧率', type: 'number', min: 15, max: 60 },
      { key: 'muse.extraMargin', label: '面部边距', type: 'number', min: 0, max: 40 },
      { key: 'muse.useFloat16', label: 'FP16 半精度（省显存）', type: 'switch' },
      { key: 'realtime.port', label: '实时服务端口', type: 'number', min: 1024, max: 65535, hint: '改动后需重启实时服务' },
      { key: 'realtime.avatarId', label: '形象 ID', type: 'text' },
      { key: 'realtime.timeoutMs', label: '单轮超时（毫秒）', type: 'number', min: 30000, max: 1800000, step: 30000 }
    ]
  },
  {
    id: 'soulx',
    title: '制曲 · SoulX-Singer',
    desc: '歌声合成（SVS）：原曲 → 分离/转写 → AI 干声 → 混伴奏',
    fields: [
      { key: 'soulx.pythonPath', label: 'Python 解释器', type: 'text', wide: true },
      { key: 'soulx.repoDir', label: 'SoulX 仓库目录', type: 'text', wide: true },
      { key: 'soulx.modelPath', label: 'SVS 模型文件', type: 'text', wide: true, hint: '相对仓库根目录' },
      { key: 'soulx.modelConfig', label: '模型配置 yaml', type: 'text', wide: true },
      {
        key: 'soulx.language', label: '演唱语言', type: 'select', options: [
          { value: 'Mandarin', label: '普通话' },
          { value: 'Cantonese', label: '粤语' },
          { value: 'English', label: '英语' }
        ]
      },
      {
        key: 'soulx.control', label: '控制模式', type: 'select', options: [
          { value: 'score', label: 'score（按曲谱，推荐）' },
          { value: 'melody', label: 'melody（按旋律）' }
        ]
      },
      { key: 'soulx.pitchShift', label: '整体变调（半音）', type: 'number', min: -12, max: 12 },
      { key: 'soulx.maxMergeDuration', label: '段落合并上限（毫秒）', type: 'number', min: 10000, max: 300000, step: 10000 },
      { key: 'soulx.device', label: '设备', type: 'select', options: [{ value: 'cuda', label: 'GPU（cuda）' }, { value: 'cpu', label: 'CPU（极慢）' }] },
      { key: 'soulx.fp16', label: 'FP16 半精度', type: 'switch' }
    ]
  },
  {
    id: 'queue',
    title: '渲染队列',
    desc: '离线任务串行执行，避免抢占实时互动显存',
    fields: [
      { key: 'queue.maxConcurrent', label: '并发任务数', type: 'number', min: 1, max: 2, hint: '8GB 显存建议保持 1' },
      { key: 'queue.simulate', label: '模拟执行（无模型时演示界面）', type: 'switch' },
      { key: 'queue.outputDir', label: '产物目录', type: 'text', wide: true }
    ]
  },
  {
    id: 'stream',
    title: '推流',
    desc: 'ffmpeg 推送到 RTMP（抖音 / B站 / 视频号）',
    fields: [
      { key: 'stream.ffmpegPath', label: 'ffmpeg 路径', type: 'text', wide: true },
      { key: 'stream.rtmpUrl', label: 'RTMP 推流地址', type: 'password', wide: true },
      {
        key: 'stream.track', label: '默认画面轨', type: 'select', options: [
          { value: 'file', label: '曲目轨（预渲染曲目）' },
          { value: 'interact', label: '互动轨（最新口型回复）' }
        ]
      },
      { key: 'stream.width', label: '宽', type: 'number', min: 320, max: 4096 },
      { key: 'stream.height', label: '高', type: 'number', min: 240, max: 4096 },
      { key: 'stream.fps', label: '帧率', type: 'number', min: 10, max: 60 },
      { key: 'stream.bitrate', label: '码率', type: 'text', placeholder: '3500k' },
      {
        key: 'stream.preset', label: '编码预设', type: 'select', options: [
          { value: 'veryfast', label: 'veryfast（低延迟）' },
          { value: 'faster', label: 'faster' },
          { value: 'medium', label: 'medium（画质优先）' }
        ]
      }
    ]
  },
  {
    id: 'danmu',
    title: '直播弹幕',
    desc: '抖音弹幕获取与半自动回复限频',
    fields: [
      { key: 'danmu.port', label: '弹幕服务端口', type: 'number', min: 1024, max: 65535 },
      { key: 'danmu.autoReply', label: '半自动回复', type: 'switch' },
      { key: 'danmu.cooldownSec', label: '同一观众冷却（秒）', type: 'number', min: 5, max: 600 },
      { key: 'danmu.maxQueue', label: '待回复队列上限', type: 'number', min: 1, max: 100 },
      { key: 'danmu.giftThanks', label: '礼物自动感谢', type: 'switch' },
      { key: 'danmu.pollMs', label: '拉取间隔（毫秒）', type: 'number', min: 500, max: 10000, step: 500 }
    ]
  },
  {
    id: 'autoDL',
    title: '云端 · AutoDL GPU 实例',
    desc: '填写开发者 Token 与 GitHub 仓库后，可在下方「云端部署」面板一键创建实例；首次部署完成后保存为私有镜像，之后免安装直接启动',
    fields: [
      { key: 'cloud.autoDL.apiKey', label: '开发者 Token', type: 'password', wide: true, placeholder: 'AutoDL 控制台 → 设置 → 开发者Token' },
      { key: 'cloud.autoDL.repoUrl', label: 'GitHub 仓库地址', type: 'text', wide: true, placeholder: 'https://github.com/your/ai-streamer-console.git（需含 deploy/cloud_bootstrap.sh）' },
      { key: 'cloud.autoDL.branch', label: '分支', type: 'text', placeholder: 'main' },
      { key: 'cloud.autoDL.dataCenter', label: '数据中心', type: 'text', placeholder: 'westDC3' },
      {
        key: 'cloud.autoDL.gpuSpec', label: '默认 GPU 规格', type: 'select', options: [
          { value: '4090D', label: 'RTX 4090D · 24GB（推理首选）' },
          { value: 'v-48g', label: 'RTX 4090 · 48GB（训练/大模型）' },
          { value: '5090-p', label: 'RTX 5090 · 32GB' }
        ]
      },
      { key: 'cloud.autoDL.imageUuid', label: '私有镜像 UUID', type: 'text', wide: true, placeholder: '留空使用公共基础镜像；首次部署后在「云端部署」面板保存' },
      { key: 'cloud.autoDL.syncOnStart', label: '实例启动时同步 GitHub 最新代码', type: 'switch', hint: '私有镜像二次启动也会 git fetch + reset 到远端最新提交；同步失败自动沿用镜像内版本' },
      { key: 'cloud.autoDL.vramMb', label: '实例显存（MB）', type: 'number', min: 0, max: 200000, step: 1024, hint: '部署时按 GPU 规格自动写入，用于能力矩阵合并计算' }
    ]
  }
];

module.exports = { GROUPS };
