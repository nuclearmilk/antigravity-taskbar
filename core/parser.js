import { EventEmitter } from 'events';
import path from 'path';

const HISTORICAL_THRESHOLD_MS = 20000;

function strArg(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed.trim();
      }
    } catch {
      // fallback to quote stripping
    }
  }
  return trimmed.replace(/^["']|["']$/g, '').trim();
}

function truncate(text, maxLen = 45) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 3))}...`;
}

function parseArtifactMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function inspectArtifactFeedback(toolCalls) {
  let cleared = null;
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const args = call.args && typeof call.args === 'object' ? call.args : null;
    if (!args) continue;
    const meta = parseArtifactMetadata(args.ArtifactMetadata);
    if (!meta) continue;
    const rawPath = strArg(args.Path) || strArg(args.TargetFile);
    const fileName = rawPath ? path.basename(rawPath) : '';
    if (meta.RequestFeedback === true) {
      return { requested: true, fileName };
    }
    if (meta.RequestFeedback === false) {
      cleared = { cleared: true, fileName };
    }
  }
  return cleared;
}

export function buildReviewWaitingStatus(pendingReview, { step, eventTs, isHistorical = false } = {}) {
  return {
    state: 'waiting',
    title: 'Antigravity 等待审阅确认...',
    detail: pendingReview?.fileName
      ? `请审阅 ${truncate(pendingReview.fileName, 24)} 并点击 Proceed`
      : '请点击反重力窗口审阅并确认',
    step,
    eventTs,
    isHistorical,
    ts: eventTs
  };
}

function formatToolDetail(name, args) {
  if (name === 'run_command') {
    const cmd = strArg(args.CommandLine);
    if (cmd) return `[命令] ${truncate(cmd, 45)}`;
  }

  if (name === 'read_file' || name === 'view_file') {
    const filePath = strArg(args.Path) || strArg(args.AbsolutePath);
    if (filePath) return `[读取] ${path.basename(filePath)}`;
  }

  if (
    name === 'edit_file' ||
    name === 'replace_file_content' ||
    name === 'multi_replace_file_content'
  ) {
    const filePath = strArg(args.Path) || strArg(args.TargetFile);
    if (filePath) return `[编辑] ${path.basename(filePath)}`;
  }

  if (name === 'write_file' || name === 'write_to_file') {
    const filePath = strArg(args.Path) || strArg(args.TargetFile);
    if (filePath) return `[写入] ${path.basename(filePath)}`;
  }

  if (name === 'search_web') {
    const query = strArg(args.query);
    if (query) return `[搜索] ${truncate(query, 45)}`;
  }

  if (name === 'grep_search') {
    const query = strArg(args.Query) || strArg(args.query);
    if (query) return `[搜索代码] ${truncate(query, 40)}`;
  }

  if (name === 'find_by_name') {
    const pattern = strArg(args.Pattern) || strArg(args.pattern);
    if (pattern) return `[查找文件] ${truncate(pattern, 40)}`;
  }

  if (name === 'list_dir') {
    const dirPath = strArg(args.DirectoryPath) || strArg(args.Path);
    if (dirPath) return `[浏览目录] ${path.basename(dirPath) || dirPath}`;
  }

  if (name === 'invoke_subagent') {
    const role = strArg(args.Role) || strArg(args.TypeName);
    return `[子代理] ${truncate(role || '执行中', 40)}`;
  }

  if (name === 'run_workflow') {
    const desc = strArg(args.Description);
    return `[工作流] ${truncate(desc || '执行中', 40)}`;
  }

  if (name === 'swarm') {
    const action = strArg(args.action);
    const target = strArg(args.name) || strArg(args.title);
    const label = [action, target].filter(Boolean).join(' ');
    return `[Swarm] ${truncate(label || '协同中', 40)}`;
  }

  return `[${name}] 执行中`;
}

export class EventParser extends EventEmitter {
  constructor(options = {}) {
    super();
    this.historicalThresholdMs = options.historicalThresholdMs ?? HISTORICAL_THRESHOLD_MS;
    this.currentStep = 0;
    this.pendingReview = null;
  }

  reset() {
    this.currentStep = 0;
    this.pendingReview = null;
  }

  clearPendingReview() {
    this.pendingReview = null;
  }

  _emitStatus(payload, silent) {
    if (!silent) {
      this.emit('status', payload);
    }
    return payload;
  }

  processLine(line, options = {}) {
    const silent = Boolean(options.silent);
    const now = typeof options.now === 'number' ? options.now : Date.now();

    try {
      const data = JSON.parse(line);
      if (!data || typeof data !== 'object') return null;

      const { type, source, status, step_index, tool_calls, content, thinking, error, created_at } = data;

      if (typeof step_index === 'number') {
        this.currentStep = step_index;
      }

      const parsedTs =
        typeof created_at === 'number' && Number.isFinite(created_at)
          ? created_at
          : typeof created_at === 'string'
            ? Date.parse(created_at)
            : NaN;
      const eventTs = Number.isFinite(parsedTs) ? parsedTs : now;
      const isHistorical = Number.isFinite(parsedTs)
        ? now - parsedTs > this.historicalThresholdMs
        : false;

      // 1. 用户输入触发
      if (type === 'USER_INPUT') {
        this.pendingReview = null;
        return this._emitStatus(
          {
            state: 'working',
            title: 'Antigravity 正在分析需求...',
            detail: '接收到用户新指令',
            step: this.currentStep,
            eventTs,
            isHistorical,
            isUserInput: true,
            ts: eventTs
          },
          silent
        );
      }

      // 2. 错误 / 取消状态（含模型响应或错误步骤）
      if (status === 'ERROR' || status === 'FAILED' || type === 'ERROR' || type === 'ERROR_MESSAGE') {
        this.pendingReview = null;
        const errText = strArg(error) || strArg(content);
        return this._emitStatus(
          {
            state: 'error',
            title: 'Antigravity 执行出错',
            detail: truncate(errText || '执行过程中发生错误', 45),
            step: this.currentStep,
            eventTs,
            isHistorical,
            ts: eventTs
          },
          silent
        );
      }

      if (status === 'CANCELED' || status === 'CANCELLED') {
        this.pendingReview = null;
        return this._emitStatus(
          {
            state: 'standby',
            title: 'Antigravity 已中止',
            detail: 'STANDBY · 任务已取消',
            step: this.currentStep,
            eventTs,
            isHistorical,
            ts: eventTs
          },
          silent
        );
      }

      // 3. 模型执行阶段
      if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
        if (Array.isArray(tool_calls) && tool_calls.length > 0) {
          const feedback = inspectArtifactFeedback(tool_calls);
          if (feedback?.requested) {
            this.pendingReview = { fileName: feedback.fileName, step: this.currentStep };
          } else if (
            feedback?.cleared &&
            this.pendingReview &&
            (!feedback.fileName ||
              !this.pendingReview.fileName ||
              feedback.fileName === this.pendingReview.fileName)
          ) {
            this.pendingReview = null;
          }

          const hasAskQuestion = tool_calls.some(
            (call) => call && typeof call === 'object' && call.name === 'ask_question'
          );
          if (hasAskQuestion) {
            return this._emitStatus(
              {
                state: 'waiting',
                title: 'Antigravity 等待用户选择...',
                detail: '请点击反重力窗口完成选项',
                step: this.currentStep,
                eventTs,
                isHistorical,
                ts: eventTs
              },
              silent
            );
          }

          const call = tool_calls.find((c) => c && typeof c === 'object') || {};
          const name = typeof call.name === 'string' && call.name ? call.name : 'tool';
          const args = call.args && typeof call.args === 'object' ? call.args : {};

          const summary = strArg(args.toolSummary);
          const detail = formatToolDetail(name, args);
          const extraCount = tool_calls.length - 1;
          const parallelTag = extraCount > 0 ? ` (+${extraCount} 项)` : '';
          const baseTitle = summary || `执行中: ${name}`;
          const title = `${baseTitle}${parallelTag} (#${this.currentStep})`;

          return this._emitStatus(
            {
              state: 'working',
              title,
              detail,
              step: this.currentStep,
              eventTs,
              isHistorical,
              ts: eventTs
            },
            silent
          );
        }

        // 无工具调用
        if (status === 'DONE') {
          if (isHistorical) {
            return this._emitStatus(
              {
                state: 'standby',
                title: 'Antigravity 就绪',
                detail: 'STANDBY · 等待下一指令',
                step: this.currentStep,
                eventTs,
                isHistorical: true,
                ts: eventTs
              },
              silent
            );
          }

          if (this.pendingReview) {
            return this._emitStatus(
              buildReviewWaitingStatus(this.pendingReview, {
                step: this.currentStep,
                eventTs,
                isHistorical: false
              }),
              silent
            );
          }

          return this._emitStatus(
            {
              state: 'completed',
              title: 'Antigravity 任务已完成',
              detail: 'Agent STANDBY · 等待下一指令',
              step: this.currentStep,
              eventTs,
              isHistorical: false,
              ts: eventTs
            },
            silent
          );
        }

        const hasThinking = typeof thinking === 'string' && thinking.trim().length > 0;
        return this._emitStatus(
          {
            state: 'working',
            title: `Antigravity 正在思考... (#${this.currentStep})`,
            detail: hasThinking ? '深度推理中' : '生成回复中',
            step: this.currentStep,
            eventTs,
            isHistorical,
            ts: eventTs
          },
          silent
        );
      }

      return null;
    } catch {
      // 容错忽略非 JSON 字符
      return null;
    }
  }
}
